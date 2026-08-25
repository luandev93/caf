import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chaveSaldo } from '../lib/legacy-keys.mjs';

const OUT_DIR = new URL('./out/', import.meta.url).pathname;
const EPSILON = 0.001;

function motivosDe(review, skipped) {
  const contagem = {};
  for (const r of review) contagem[r.motivo] = (contagem[r.motivo] ?? 0) + 1;
  for (const s of skipped) contagem[s.motivo] = (contagem[s.motivo] ?? 0) + 1;
  return contagem;
}

/**
 * Reconciliação puramente em memória — não lê nem escreve no banco. Compara
 * o que existia na origem (Firestore) contra o que o saneamento decidiu
 * migrar (bucket `auto`), no formato pedido: origem vs migrados vs sem
 * correspondência, e saldo origem vs destino (projetado) vs diferença.
 *
 * `destinoReal`, se informado (após um --commit real), substitui o valor
 * projetado pelo valor efetivamente lido do Postgres, para o relatório
 * refletir o estado real do banco em vez de uma simulação.
 */
export function computeReconciliation({ itens, saldos, auto, review, skipped, destinoReal }) {
  const itemIdsAuto = new Set(auto.map((a) => a.itemId));

  const origemPorChave = new Map();
  for (const s of saldos) {
    const chave = chaveSaldo(s.data.estoqueId, s.data.itemId);
    const qtd = Number(s.data.qtd) || 0;
    const atual = origemPorChave.get(chave) ?? { origem: 0, itemId: s.data.itemId };
    atual.origem += qtd;
    origemPorChave.set(chave, atual);
  }

  let origemTotal = 0;
  let destinoProjetadoTotal = 0;
  const porChaveComDiferenca = [];
  for (const [chave, { origem, itemId }] of origemPorChave) {
    origemTotal += origem;
    const migrado = itemIdsAuto.has(itemId);
    const destinoProjetado = migrado ? origem : 0;
    destinoProjetadoTotal += destinoProjetado;
    if (!migrado && Math.abs(origem) > EPSILON) {
      porChaveComDiferenca.push({ chave, origem, destinoProjetado: 0, diferenca: origem, motivo: 'produto-nao-migrado' });
    }
  }

  const destino = destinoReal ?? { total: destinoProjetadoTotal, fonte: 'projetado' };

  return {
    itens: {
      origem: itens.length,
      migrados: auto.length,
      semCorrespondencia: review.length + skipped.length,
      semCorrespondenciaPorMotivo: motivosDe(review, skipped),
    },
    saldo: {
      origemTotal,
      destinoTotal: destino.total,
      destinoFonte: destino.fonte,
      diferencaTotal: origemTotal - destino.total,
      porChaveComDiferenca,
    },
  };
}

export async function writeReconciliationReport(reconciliation, { generatedAt, mode }) {
  await mkdir(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, 'reconciliation-report.json');
  const mdPath = path.join(OUT_DIR, 'reconciliation-report.md');

  await writeFile(jsonPath, JSON.stringify({ generatedAt, mode, ...reconciliation }, null, 2));

  const { itens, saldo } = reconciliation;
  const md = [
    '# Relatório de reconciliação — migração legado → Neon',
    '',
    `Gerado em: ${generatedAt} (modo: ${mode})`,
    '',
    '## Itens',
    '',
    `- origem: ${itens.origem}`,
    `- migrados: ${itens.migrados}`,
    `- sem correspondência: ${itens.semCorrespondencia}`,
    '- por motivo:',
    ...Object.entries(itens.semCorrespondenciaPorMotivo).map(([m, n]) => `  - ${m}: ${n}`),
    '',
    '## Saldo',
    '',
    `- origem (total): ${saldo.origemTotal}`,
    `- destino (${saldo.destinoFonte}): ${saldo.destinoTotal}`,
    `- diferença: ${saldo.diferencaTotal}`,
    '',
    saldo.diferencaTotal === 0
      ? '✅ diferença zero — reconciliação bateu.'
      : `⚠️ diferença > 0 — esperada apenas para chaves pendentes de revisão (ver lista abaixo), nunca para itens já migrados.`,
    '',
    '### Chaves com diferença (produto ainda não migrado / pendente de revisão)',
    '',
    '```json',
    JSON.stringify(saldo.porChaveComDiferenca.slice(0, 50), null, 2),
    saldo.porChaveComDiferenca.length > 50 ? `... (+${saldo.porChaveComDiferenca.length - 50} não exibidas)` : '',
    '```',
  ].join('\n');

  await writeFile(mdPath, md);
  return { jsonPath, mdPath };
}
