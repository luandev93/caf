#!/usr/bin/env node
import 'dotenv/config';
import { COLLECTORS, collectAuthUsers } from './collectors/index.mjs';
import { buildAllFlags } from './quality-flags.mjs';
import { writeAuditReport, redigirAmostra } from './report.mjs';

async function main() {
  console.log('Auditoria do legado Firebase (farmhmmv) — somente leitura\n');

  const collected = {};
  for (const [name, collector] of Object.entries(COLLECTORS)) {
    process.stdout.write(`  coletando ${name}... `);
    collected[name] = await collector();
    console.log(`${collected[name].count} documentos`);
  }

  process.stdout.write('  coletando Firebase Auth users... ');
  const authUsers = await collectAuthUsers();
  console.log(`${authUsers.length} contas`);

  const flags = buildAllFlags({
    itens: collected.itens.docs,
    saldos: collected.saldos.docs,
    lotes: collected.lotes.docs,
    estoques: collected.estoques.docs,
    pessoas: collected.pessoas.docs,
    authUsers,
  });

  const counts = Object.fromEntries(
    Object.entries(collected).map(([name, c]) => [name, c.count])
  );
  counts.firebaseAuthUsers = authUsers.length;

  const samples = Object.fromEntries(
    Object.entries(collected).map(([name, c]) => [name, c.docs.map(redigirAmostra)])
  );

  const { jsonPath, mdPath } = await writeAuditReport({
    counts,
    samples,
    flags,
    generatedAt: new Date().toISOString(),
  });

  console.log('\nRelatório gerado:');
  console.log(`  ${jsonPath}`);
  console.log(`  ${mdPath}`);

  const totalFlags = Object.values(flags).reduce((acc, l) => acc + l.length, 0);
  console.log(`\nTotal de ocorrências flagadas: ${totalFlags}`);
}

main().catch((err) => {
  console.error('\nAuditoria falhou:', err.message);
  process.exitCode = 1;
});
