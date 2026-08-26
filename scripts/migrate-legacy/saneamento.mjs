// Regras de saneamento/canonicalização do catálogo legado (Firestore `itens`
// + `saldos`) antes de virar `Product`/`StockBalance` no Neon.
//
// Tudo aqui é função pura — sem I/O, sem Firestore, sem Prisma — de propósito:
// dá pra testar com fixtures (ver saneamento.test.mjs) e reusar tanto no
// dry-run quanto no commit de verdade, sem duplicar a lógica de decisão.
//
// Chave de dedup é sempre `codigo`, nunca o nome/descrição isolado — nomes
// de medicamento se repetem por natureza (mesmo princípio ativo, apresentações
// diferentes); código é o único campo de negócio estável no legado, mesmo
// sem unicidade garantida pelo Firestore.

/** Normaliza um doc bruto de `itens` pro shape interno usado daqui pra frente. */
export function normalizeLegacyItem(raw) {
  return {
    id: raw.id,
    codigo: raw.codigo ?? null,
    descricao: raw.descricao ?? raw.nome ?? '',
    ativo: raw.ativo ?? true,
    pendente: Boolean(raw.pendente),
    unidade: raw.unidade ?? null,
    tipo: raw.tipo ?? null,
  };
}

/** Remove acentos, colapsa espaços e uniformiza caixa — só pra comparação. */
export function normalizeDescription(descricao) {
  return (descricao ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

/**
 * Classifica itens normalizados em três baldes: `auto` (migra sem revisão
 * humana), `review` (fila de decisão) e `excluido` (fora do baseline, mas
 * registrado — nunca silenciosamente descartado).
 *
 * @param {ReturnType<typeof normalizeLegacyItem>[]} items
 * @param {Map<string, number>} saldoTotalPorItemId soma de `saldos.qtd` por item
 */
export function classifyLegacyItems(items, saldoTotalPorItemId) {
  const saldoDe = (itemId) => saldoTotalPorItemId.get(itemId) ?? 0;

  // Passo 1 — pendente sem saldo nunca entra no baseline (não existe de fato
  // como estoque hoje); pendente COM saldo não pode simplesmente sumir, então
  // vai pra revisão em vez de exclusão.
  const excluido = [];
  const candidatos = [];
  for (const item of items) {
    if (item.pendente && saldoDe(item.id) <= 0) {
      excluido.push({ item, motivos: ['pendente-sem-saldo'] });
    } else {
      candidatos.push(item);
    }
  }

  // Passo 2 — agrupa por código pra achar duplicatas (dedup key = codigo).
  const porCodigo = new Map();
  for (const item of candidatos) {
    if (!item.codigo) continue;
    if (!porCodigo.has(item.codigo)) porCodigo.set(item.codigo, []);
    porCodigo.get(item.codigo).push(item);
  }

  // Passo 3 — agrupa por descrição normalizada pra achar possíveis
  // duplicatas com códigos diferentes. Heurística deliberadamente simples
  // (match exato pós-normalização, sem similaridade fuzzy) — zero
  // dependência extra, zero custo, e cobre o caso mais comum (mesmo texto,
  // grafias diferentes). Casos mais sutis continuam exigindo o olho humano
  // na fila de revisão de qualquer forma.
  const porDescricao = new Map();
  for (const item of candidatos) {
    const chave = normalizeDescription(item.descricao);
    if (!chave) continue;
    if (!porDescricao.has(chave)) porDescricao.set(chave, []);
    porDescricao.get(chave).push(item);
  }
  const idsComPossivelDuplicata = new Set();
  for (const grupo of porDescricao.values()) {
    const codigosDistintos = new Set(grupo.map((i) => i.codigo));
    if (codigosDistintos.size > 1) {
      for (const item of grupo) idsComPossivelDuplicata.add(item.id);
    }
  }

  const auto = [];
  const review = [];
  for (const item of candidatos) {
    const motivos = [];

    if (!item.codigo) motivos.push('sem-codigo');
    else if (porCodigo.get(item.codigo).length > 1) motivos.push('codigo-duplicado');

    if (idsComPossivelDuplicata.has(item.id)) motivos.push('possivel-duplicata');
    if (item.pendente && saldoDe(item.id) > 0) motivos.push('pendente-com-saldo');
    if (item.ativo === false && saldoDe(item.id) > 0) motivos.push('inativo-com-saldo');

    if (motivos.length === 0) auto.push(item);
    else review.push({ item, motivos });
  }

  return { auto, review, excluido };
}
