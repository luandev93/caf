#!/usr/bin/env node
import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanearCatalogo } from './saneamento.mjs';
import { computeReconciliation, writeReconciliationReport } from './reconcile-report.mjs';
import { emitMigrationSql } from './sql-emit.mjs';

const OUT_DIR = new URL('./out/', import.meta.url).pathname;

function parseArgs(argv) {
  const args = { dryRun: true, scope: 'all', via: 'prisma' };
  for (const arg of argv) {
    if (arg === '--commit') args.dryRun = false;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--scope=')) args.scope = arg.slice('--scope='.length);
    else if (arg.startsWith('--target=')) args.target = arg.slice('--target='.length);
    else if (arg.startsWith('--input=')) args.input = arg.slice('--input='.length);
    // --via=sql-emit: em vez de conectar via PrismaClient (precisa de TCP
    // direto ao Postgres, indisponível em sandboxes só-HTTPS), grava os
    // statements SQL equivalentes em out/commit-statements.json para serem
    // aplicados manualmente via mcp__Neon__run_sql_transaction. Ver plano,
    // adendo "commit via Neon MCP".
    else if (arg.startsWith('--via=')) args.via = arg.slice('--via='.length);
  }
  return args;
}

/**
 * Fonte dos dados legados: `--input=arquivo.json` (formato
 * { itens: [...], saldos: [...], estoques: [...] }, útil para testar o
 * pipeline sem credencial do Firebase) ou, por padrão, o Firestore ao vivo
 * via firebase-admin (mesmo cliente somente-leitura do audit).
 */
async function carregarDadosLegado(args) {
  if (args.input) {
    const raw = await readFile(args.input, 'utf8');
    return JSON.parse(raw);
  }
  const { collectItens, collectSaldos, collectEstoques } = await import('../legacy-audit/collectors/index.mjs');
  const [itens, saldos, estoques] = await Promise.all([collectItens(), collectSaldos(), collectEstoques()]);
  return { itens: itens.docs, saldos: saldos.docs, estoques: estoques.docs };
}

function saldosPorItemId(saldos) {
  const mapa = new Map();
  for (const s of saldos) {
    const qtd = Number(s.data.qtd) || 0;
    mapa.set(s.data.itemId, (mapa.get(s.data.itemId) ?? 0) + qtd);
  }
  return mapa;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modo = args.dryRun ? 'dry-run (nenhuma escrita)' : 'COMMIT (grava no --target)';
  console.log(`Migração legado → Neon — modo: ${modo}, escopo: ${args.scope}\n`);

  const { itens, saldos, estoques } = await carregarDadosLegado(args);
  console.log(`  itens: ${itens.length}  saldos: ${saldos.length}  estoques: ${estoques.length}`);

  const { auto, review, skipped } = sanearCatalogo(itens, saldosPorItemId(saldos));
  console.log(`  saneamento: auto=${auto.length} review=${review.length} skipped=${skipped.length}\n`);

  let destinoReal;

  if (!args.dryRun && args.via === 'sql-emit') {
    const importBatchId = `import-${new Date().toISOString()}`;
    const { statements, ids, semCorrespondencia } = emitMigrationSql({ auto, estoques, saldos, importBatchId });
    await mkdir(OUT_DIR, { recursive: true });
    const outPath = path.join(OUT_DIR, 'commit-statements.json');
    await writeFile(outPath, JSON.stringify({ importBatchId, statements, semCorrespondencia }, null, 2));
    console.log(`  ${statements.length} statements SQL gerados em ${outPath}`);
    console.log('  Nenhuma escrita foi feita — aplique via mcp__Neon__run_sql_transaction (ver plano).');
    console.log(`  ids determinísticos: institution=${ids.institutionId}`);
    // destinoReal fica indefinido aqui de propósito: sem PrismaClient/TCP
    // não há como consultar o banco a partir deste script neste modo; a
    // reconciliação pós-commit é feita separadamente via Neon MCP (run_sql).
  } else if (!args.dryRun) {
    if (!args.target && !process.env.DATABASE_URL) {
      throw new Error('--commit exige --target=<connection string> (ou DATABASE_URL no ambiente) apontando para uma branch de DEV do Neon — nunca main.');
    }
    console.log('  Gravando no destino (--commit)...');
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient(args.target ? { datasources: { db: { url: args.target } } } : undefined);
    const { ensureDefaultInstitution, upsertStockLocations, upsertProducts, upsertStockBalances, readDestinoReal } =
      await import('./write-prisma.mjs');

    const importBatchId = `import-${new Date().toISOString()}`;
    try {
      const institution = await ensureDefaultInstitution(prisma);
      const estoqueIdToStockLocationId = await upsertStockLocations(prisma, estoques, institution.id, importBatchId);
      const itemIdToProductId = await upsertProducts(prisma, auto, importBatchId);
      const { written, semCorrespondencia } = await upsertStockBalances(
        prisma,
        saldos,
        itemIdToProductId,
        estoqueIdToStockLocationId
      );
      console.log(`  StockBalance gravados: ${written.length}, sem correspondência: ${semCorrespondencia.length}`);
      destinoReal = await readDestinoReal(prisma);
    } finally {
      await prisma.$disconnect();
    }
  }

  const reconciliation = computeReconciliation({ itens, saldos, auto, review, skipped, destinoReal });
  const { jsonPath, mdPath } = await writeReconciliationReport(reconciliation, {
    generatedAt: new Date().toISOString(),
    mode: args.dryRun ? 'dry-run' : 'commit',
  });

  console.log('\nRelatório de reconciliação:');
  console.log(`  ${jsonPath}`);
  console.log(`  ${mdPath}`);
  console.log(`\nSaldo — origem: ${reconciliation.saldo.origemTotal}  destino: ${reconciliation.saldo.destinoTotal}  diferença: ${reconciliation.saldo.diferencaTotal}`);
}

main().catch((err) => {
  console.error('\nMigração falhou:', err.message);
  process.exitCode = 1;
});
