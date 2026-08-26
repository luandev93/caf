#!/usr/bin/env node
// CLI de migração do catálogo/saldo/estoques legado (Firestore `farm`) para
// o Neon do `caf`. `--dry-run` é o padrão de propósito: rodar isso sem
// pensar nunca deveria escrever em lugar nenhum.
//
// Uso:
//   node scripts/migrate-legacy/index.mjs --dry-run --scope=all --source=fixture
//   node scripts/migrate-legacy/index.mjs --commit --scope=all --target=sql   (gera out/commit-statements.json)
//   node scripts/migrate-legacy/index.mjs --commit --scope=all --target=prisma --database-url=...
//
// --source=fixture usa scripts/migrate-legacy/fixtures/sample-legacy-data.json
// (não requer credencial do Firebase). --source=firebase lê direto do
// Firestore de produção (requer as env vars de .env.example) — use com
// cuidado, mesmo em --dry-run isso já consome cota de leitura do free tier.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeLegacyItem, classifyLegacyItems } from './saneamento.mjs';
import { buildReconciliationReport, formatReconciliationReport } from './reconcile-report.mjs';
import { emitCommitStatements } from './sql-emit.mjs';

function parseArgs(argv) {
  const args = { dryRun: true, scope: 'all', source: 'fixture', target: 'sql' };
  for (const arg of argv) {
    if (arg === '--commit') args.dryRun = false;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--scope=')) args.scope = arg.slice('--scope='.length);
    else if (arg.startsWith('--source=')) args.source = arg.slice('--source='.length);
    else if (arg.startsWith('--target=')) args.target = arg.slice('--target='.length);
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
  }
  return args;
}

async function loadFromFixture() {
  const fixturePath = new URL('./fixtures/sample-legacy-data.json', import.meta.url);
  const raw = JSON.parse(await readFile(fixturePath, 'utf8'));
  return {
    itens: raw.itens,
    saldos: raw.saldos,
    estoques: raw.estoques ?? [{ id: 'e1', nome: 'Estoque de teste (fixture)', ativo: true }],
  };
}

async function loadFromFirebase() {
  // Import dinâmico: quem roda só com --source=fixture não precisa nem ter
  // firebase-admin instalado configurado corretamente.
  const { getLegacyFirestore, paginate } = await import('../legacy-audit/firebase-admin-client.mjs');
  const db = getLegacyFirestore();
  const collect = async (name) => {
    const docs = [];
    for await (const doc of paginate(db.collection(name))) docs.push({ id: doc.id, ...doc.data() });
    return docs;
  };
  const [itens, saldos, estoques] = await Promise.all([collect('itens'), collect('saldos'), collect('estoques')]);
  return { itens, saldos, estoques: estoques.map((e) => ({ id: e.id, nome: e.nome, ativo: e.ativo })) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out ?? 'scripts/migrate-legacy/out';

  const { itens, saldos, estoques } = args.source === 'firebase' ? await loadFromFirebase() : await loadFromFixture();

  const normalizados = itens.map(normalizeLegacyItem);
  const saldoTotalPorItemId = new Map();
  for (const s of saldos) saldoTotalPorItemId.set(s.itemId, (saldoTotalPorItemId.get(s.itemId) ?? 0) + Number(s.qtd ?? 0));

  const classificacao = classifyLegacyItems(normalizados, saldoTotalPorItemId);
  const report = buildReconciliationReport({ totalItensOrigem: itens.length, classificacao, saldosOrigem: saldos });

  process.stdout.write(formatReconciliationReport(report) + '\n\n');

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'reconciliation-report.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(
    path.join(outDir, 'review-queue.json'),
    JSON.stringify({ review: classificacao.review, excluido: classificacao.excluido }, null, 2),
    'utf8'
  );

  if (args.dryRun) {
    process.stdout.write(`Dry-run — nada foi escrito no destino. Relatórios em ${outDir}/\n`);
    return;
  }

  // --commit passou daqui. institutionId precisa já existir no destino —
  // este script nunca cria uma Institution nova sozinho (é dado de config,
  // não algo pra inferir do legado).
  const institutionId = process.env.CAF_INSTITUTION_ID;
  if (!institutionId) {
    throw new Error('CAF_INSTITUTION_ID é obrigatório em --commit (id da Institution já existente no destino).');
  }
  const importBatchId = `import-${new Date().toISOString()}`;

  if (args.target === 'sql') {
    const statements = emitCommitStatements({ institutionId, estoques, classificacao, saldosOrigem: saldos, importBatchId });
    const outPath = path.join(outDir, 'commit-statements.json');
    await writeFile(outPath, JSON.stringify(statements, null, 2), 'utf8');
    process.stdout.write(
      `${statements.length} statements gerados em ${outPath}.\n` +
        'Aplique via mcp__Neon__run_sql_transaction numa sessão Claude, contra a branch de dev — nunca contra main.\n'
    );
    return;
  }

  if (args.target === 'prisma') {
    const { PrismaClient } = await import('@prisma/client');
    const { commitToDatabase } = await import('./write-prisma.mjs');
    const prisma = new PrismaClient();
    try {
      await commitToDatabase(prisma, { institutionId, estoques, classificacao, saldosOrigem: saldos, importBatchId });
      process.stdout.write('Commit via Prisma concluído.\n');
    } finally {
      await prisma.$disconnect();
    }
    return;
  }

  throw new Error(`--target desconhecido: ${args.target} (use "sql" ou "prisma")`);
}

main().catch((err) => {
  console.error('Migração falhou:', err.message);
  process.exitCode = 1;
});
