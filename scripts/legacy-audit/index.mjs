#!/usr/bin/env node
// Auditoria somente-leitura do Firestore de produção do `farm` (farmhmmv).
//
// Objetivo: substituir suposições ("549 produtos") por contagens reais, e
// levantar flags de qualidade que orientam as regras de saneamento em
// ../migrate-legacy/saneamento.mjs — antes de qualquer migração de verdade.
//
// Não escreve nada no Firestore. Não precisa (nem deve) rodar em produção
// com frequência: é um relatório pontual, não um monitor contínuo.
//
// Uso:
//   npm run audit:legacy
//   node scripts/legacy-audit/index.mjs --out=scripts/legacy-audit/out
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getLegacyFirestore, getLegacyAuth, paginate } from './firebase-admin-client.mjs';
import { quantidadeValida } from '../shared/quantidade.mjs';

const OUT_DIR = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length)
  ?? 'scripts/legacy-audit/out';

// Coleções do farm (ver src/lib/db.js do repo `farm`). `catalogoPublico`,
// `solicitacoes`, `emprestimos`, `logs`, `config` ficam fora do escopo desta
// fase (não fazem parte do baseline mínimo de recuperação).
const COLLECTIONS = ['itens', 'saldos', 'lotes', 'pessoas', 'usuarios', 'movimentos', 'estoques'];

// Nunca coloca PII (nome, CPF, e-mail, telefone) numa amostra de relatório.
// Mantém só o que serve pra diagnosticar shape/qualidade dos dados.
function redact(docData, collectionName) {
  const { id, ...rest } = docData;
  if (collectionName === 'pessoas' || collectionName === 'usuarios') {
    // O uid do Firebase Auth é o próprio id do documento (ver seção
    // "pessoas com login" mais abaixo) — não existe um campo de uid separado.
    return {
      id,
      hasLogin: Boolean(rest?.acesso?.temLogin),
      role: rest?.papel ?? rest?.role ?? null,
      ativo: rest?.ativo ?? null,
    };
  }
  return rest; // itens/saldos/lotes/estoques/movimentos: catálogo, não PII de paciente/usuário.
}

function normalizeDescription(desc) {
  return (desc ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

async function countAndSample(db, collectionName, { sampleSize = 3 } = {}) {
  let count = 0;
  const sample = [];
  const docsById = new Map();
  for await (const doc of paginate(db.collection(collectionName))) {
    count += 1;
    const data = { id: doc.id, ...doc.data() };
    docsById.set(doc.id, data);
    if (sample.length < sampleSize) sample.push(redact(data, collectionName));
  }
  return { count, sample, docsById };
}

async function main() {
  const db = getLegacyFirestore();
  const report = { geradoEm: new Date().toISOString(), colecoes: {}, flags: {} };
  const raw = {};

  for (const name of COLLECTIONS) {
    process.stdout.write(`Lendo ${name}...\n`);
    const { count, sample, docsById } = await countAndSample(db, name);
    report.colecoes[name] = { contagem: count, amostra: sample };
    raw[name] = docsById;
  }

  // --- Flags de qualidade do catálogo (itens) -------------------------------
  const itens = [...raw.itens.values()];
  const porCodigo = new Map();
  const porDescricao = new Map();
  for (const item of itens) {
    const codigo = item.codigo ?? null;
    if (codigo) {
      if (!porCodigo.has(codigo)) porCodigo.set(codigo, []);
      porCodigo.get(codigo).push(item.id);
    }
    const desc = normalizeDescription(item.descricao ?? item.nome);
    if (desc) {
      if (!porDescricao.has(desc)) porDescricao.set(desc, []);
      porDescricao.get(desc).push({ id: item.id, codigo });
    }
  }

  const semCodigo = itens.filter((i) => !i.codigo).map((i) => i.id);
  const codigoDuplicado = [...porCodigo.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([codigo, ids]) => ({ codigo, ids }));
  const descricaoDuplicadaCodigoDiferente = [...porDescricao.entries()]
    .filter(([, entries]) => new Set(entries.map((e) => e.codigo)).size > 1)
    .map(([descricao, entries]) => ({ descricao, entries }));

  const pendenteSemSaldo = [];
  const pendenteComSaldo = [];
  const inativoComSaldo = [];
  const saldosComQuantidadeInvalida = [];
  const saldosPorItem = new Map();
  for (const saldo of raw.saldos.values()) {
    const qtd = quantidadeValida(saldo.qtd ?? saldo.quantidade);
    if (qtd === null) {
      saldosComQuantidadeInvalida.push({ id: saldo.id, valorBruto: saldo.qtd });
      continue;
    }
    saldosPorItem.set(saldo.itemId, (saldosPorItem.get(saldo.itemId) ?? 0) + qtd);
  }
  for (const item of itens) {
    const saldoTotal = saldosPorItem.get(item.id) ?? 0;
    if (item.pendente && saldoTotal <= 0) pendenteSemSaldo.push(item.id);
    if (item.pendente && saldoTotal > 0) pendenteComSaldo.push(item.id);
    if (item.ativo === false && saldoTotal > 0) inativoComSaldo.push(item.id);
  }

  // --- Saldos/lotes órfãos e divergência lotes x saldos ---------------------
  const itemIds = new Set(itens.map((i) => i.id));
  const estoqueIds = new Set([...raw.estoques.values()].map((e) => e.id));
  const saldosOrfaos = [...raw.saldos.values()]
    .filter((s) => !itemIds.has(s.itemId) || !estoqueIds.has(s.estoqueId))
    .map((s) => s.id);
  const lotesOrfaos = [...raw.lotes.values()]
    .filter((l) => !itemIds.has(l.itemId) || !estoqueIds.has(l.estoqueId))
    .map((l) => l.id);

  // Alguns docs de `lotes` têm `qtd` guardado como o sentinel não resolvido de
  // FieldValue.increment() (ex: `{ $u: 12, _methodName: 'increment' }`) em vez
  // de um número — sinal de um bug real no app legado (um update que serializa
  // o sentinel errado em vez de deixar o SDK resolvê-lo). Não dá pra somar
  // esses como zero silenciosamente (mascararia a divergência) nem como NaN
  // (quebra a comparação) — cada ocorrência vira uma flag própria.
  const lotesComQuantidadeInvalida = [];
  const somaLotesPorChave = new Map(); // chave = `${estoqueId}__${itemId}`
  for (const lote of raw.lotes.values()) {
    const chave = `${lote.estoqueId}__${lote.itemId}`;
    const qtd = quantidadeValida(lote.qtd ?? lote.quantidade);
    if (qtd === null) {
      lotesComQuantidadeInvalida.push({ id: lote.id, chave, valorBruto: lote.qtd });
      continue; // não soma um valor que não é número de verdade
    }
    somaLotesPorChave.set(chave, (somaLotesPorChave.get(chave) ?? 0) + qtd);
  }
  const divergenciaLotesSaldos = [];
  for (const saldo of raw.saldos.values()) {
    const chave = `${saldo.estoqueId}__${saldo.itemId}`;
    if (!somaLotesPorChave.has(chave)) continue; // item não controla lote — não é divergência
    const somaLotes = somaLotesPorChave.get(chave);
    const qtdSaldo = Number(saldo.qtd ?? saldo.quantidade ?? 0);
    if (somaLotes !== qtdSaldo) {
      divergenciaLotesSaldos.push({ chave, somaLotes, qtdSaldo, diferenca: qtdSaldo - somaLotes });
    }
  }

  // --- pessoas com temLogin=true sem uid válido no Firebase Auth ------------
  // Convenção do legado: o id do doc em `pessoas` É o uid do Firebase Auth
  // (não existe um campo `acesso.uid` separado) — confirmado batendo
  // `pessoas/{id}` contra `movimentos.usuarioUid` de quem editou aquele
  // cadastro.
  const pessoasComLogin = [...raw.pessoas.values()].filter((p) => p?.acesso?.temLogin);
  const auth = getLegacyAuth();
  const semUidCorrespondente = [];
  for (const pessoa of pessoasComLogin) {
    try {
      await auth.getUser(pessoa.id);
    } catch {
      semUidCorrespondente.push({ id: pessoa.id, motivo: 'uid-nao-encontrado-no-auth' });
    }
  }

  report.flags = {
    itensSemCodigo: { total: semCodigo.length, ids: semCodigo },
    itensCodigoDuplicado: { total: codigoDuplicado.length, detalhe: codigoDuplicado },
    itensDescricaoDuplicadaCodigoDiferente: {
      total: descricaoDuplicadaCodigoDiferente.length,
      detalhe: descricaoDuplicadaCodigoDiferente,
    },
    itensPendenteSemSaldo: { total: pendenteSemSaldo.length, ids: pendenteSemSaldo },
    itensPendenteComSaldo: { total: pendenteComSaldo.length, ids: pendenteComSaldo },
    itensInativoComSaldo: { total: inativoComSaldo.length, ids: inativoComSaldo },
    saldosOrfaos: { total: saldosOrfaos.length, ids: saldosOrfaos },
    lotesOrfaos: { total: lotesOrfaos.length, ids: lotesOrfaos },
    saldosComQuantidadeInvalida: { total: saldosComQuantidadeInvalida.length, detalhe: saldosComQuantidadeInvalida },
    lotesComQuantidadeInvalida: { total: lotesComQuantidadeInvalida.length, detalhe: lotesComQuantidadeInvalida },
    divergenciaLotesSaldos: { total: divergenciaLotesSaldos.length, detalhe: divergenciaLotesSaldos },
    pessoasComLoginSemUidValido: { total: semUidCorrespondente.length, detalhe: semUidCorrespondente },
  };

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'legacy-audit-report.json');
  await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');

  process.stdout.write(`\nRelatório salvo em ${outPath}\n\n`);
  for (const [nome, { contagem }] of Object.entries(report.colecoes)) {
    process.stdout.write(`${nome.padEnd(12)} ${contagem}\n`);
  }
  process.stdout.write('\nFlags de qualidade:\n');
  for (const [flag, { total }] of Object.entries(report.flags)) {
    process.stdout.write(`  ${flag.padEnd(40)} ${total}\n`);
  }
}

main().catch((err) => {
  console.error('Auditoria falhou:', err.message);
  process.exitCode = 1;
});
