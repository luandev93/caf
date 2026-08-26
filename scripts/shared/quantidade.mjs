// Normaliza uma quantidade vinda do Firestore (`itens`, `saldos`, `lotes`).
//
// Alguns documentos legados guardam `qtd` como o sentinel não resolvido de
// `FieldValue.increment()` (ex: `{ $u: 12, _methodName: 'increment' }`) em
// vez de um número — é um bug real de escrita no app `farm` (algo no
// caminho de update serializa o sentinel em vez de deixar o SDK resolvê-lo
// no servidor), não um formato alternativo válido.
//
// `null` sinaliza "não dá pra confiar nesse valor" — quem chama decide o
// que fazer (excluir da soma, reportar como flag de qualidade). Nunca
// retorna NaN: isso silenciosamente contaminaria qualquer soma downstream.
export function quantidadeValida(bruto) {
  if (bruto === undefined || bruto === null) return 0;
  const n = Number(bruto);
  return Number.isFinite(n) ? n : null;
}
