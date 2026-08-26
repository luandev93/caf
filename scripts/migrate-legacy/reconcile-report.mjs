// Relatório de reconciliação: prova, em números, que nada sumiu na
// migração — todo item e toda unidade de saldo de origem tem um destino
// explicado (migrado, ou numa fila de revisão com motivo).
//
// A régua de aceite do bucket `auto` é diferença zero: se sobrar diferença
// de saldo num item que foi pro baseline automático, é bug em saneamento.mjs
// ou em write-prisma.mjs/sql-emit.mjs, não uma divergência aceitável.

function contarPorMotivo(entradas) {
  const porMotivo = {};
  for (const { motivos } of entradas) {
    for (const motivo of motivos) {
      porMotivo[motivo] = (porMotivo[motivo] ?? 0) + 1;
    }
  }
  return porMotivo;
}

/**
 * @param {object} params
 * @param {number} params.totalItensOrigem
 * @param {{auto: any[], review: {item:any, motivos:string[]}[], excluido: {item:any, motivos:string[]}[]}} params.classificacao
 * @param {{itemId: string, estoqueId: string, qtd: number}[]} params.saldosOrigem
 */
export function buildReconciliationReport({ totalItensOrigem, classificacao, saldosOrigem }) {
  const idsAuto = new Set(classificacao.auto.map((i) => i.id));

  const itens = {
    origem: totalItensOrigem,
    migrados: classificacao.auto.length,
    semCorrespondencia: classificacao.review.length + classificacao.excluido.length,
    porSubRazao: {
      ...contarPorMotivo(classificacao.review),
      ...contarPorMotivo(classificacao.excluido),
    },
  };

  let origemTotal = 0;
  let destinoTotal = 0;
  const porChaveNaoMigrada = [];
  for (const saldo of saldosOrigem) {
    const qtd = Number(saldo.qtd ?? 0);
    origemTotal += qtd;
    const chave = `${saldo.estoqueId}__${saldo.itemId}`;
    if (idsAuto.has(saldo.itemId)) {
      destinoTotal += qtd;
    } else if (qtd !== 0) {
      porChaveNaoMigrada.push({ chave, itemId: saldo.itemId, qtd });
    }
  }

  const saldo = {
    origemTotal,
    destinoTotal,
    diferenca: origemTotal - destinoTotal,
    porChaveNaoMigrada,
  };

  return { itens, saldo };
}

/** Formata o relatório pra leitura humana no terminal (não é o formato de máquina). */
export function formatReconciliationReport(report) {
  const linhas = [];
  linhas.push('--- Itens ---');
  linhas.push(`origem: ${report.itens.origem}  migrados: ${report.itens.migrados}  sem correspondência: ${report.itens.semCorrespondencia}`);
  for (const [motivo, total] of Object.entries(report.itens.porSubRazao)) {
    linhas.push(`  ${motivo.padEnd(24)} ${total}`);
  }
  linhas.push('--- Saldo ---');
  linhas.push(`origem: ${report.saldo.origemTotal}  destino: ${report.saldo.destinoTotal}  diferença: ${report.saldo.diferenca}`);
  if (report.saldo.porChaveNaoMigrada.length > 0) {
    linhas.push('  chaves não migradas (item ainda na fila de revisão/exclusão):');
    for (const { chave, qtd } of report.saldo.porChaveNaoMigrada) {
      linhas.push(`    ${chave.padEnd(30)} qtd=${qtd}`);
    }
  }
  return linhas.join('\n');
}
