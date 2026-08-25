/** Réplica mínima de src/lib/utils.js do repo farm — mantém a mesma normalização
 * usada lá para que chaves calculadas aqui batam com as do sistema legado. */
const COMBINING_DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');

export function semAcento(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS, '')
    .toLowerCase()
    .trim();
}

export const chaveSaldo = (estoqueId, itemId) => `${estoqueId}__${itemId}`;

export const idLote = (estoqueId, itemId, lote, validade) =>
  `${estoqueId}__${itemId}__${semAcento(lote || 'sem-lote')}__${validade || 'sem-validade'}`;
