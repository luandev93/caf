// Só é chamado quando --commit é passado explicitamente (nunca no dry-run
// padrão). O alvo (--target / DATABASE_URL) deve ser sempre uma branch de
// dev descartável durante esta fase — nunca a branch `main` do Neon.

const DEFAULT_INSTITUTION_NAME =
  'HMMV (padrão provisório — redefinir por unidade após auditoria completa)';

async function upsertLegacyMapping(
  prisma,
  { entityType, legacyCollection, legacyDocId, legacyCode, productId, userId, stockLocationId, importBatchId }
) {
  return prisma.legacyMapping.upsert({
    where: { legacyCollection_legacyDocId: { legacyCollection, legacyDocId } },
    create: { entityType, legacyCollection, legacyDocId, legacyCode, productId, userId, stockLocationId, importBatchId },
    update: { productId, userId, stockLocationId, importBatchId },
  });
}

/** Garante uma Institution placeholder para ancorar StockLocations enquanto
 * o mapeamento real HM/UBS por estoque não foi confirmado com o usuário. */
export async function ensureDefaultInstitution(prisma) {
  const existing = await prisma.institution.findFirst({ where: { name: DEFAULT_INSTITUTION_NAME } });
  if (existing) return existing;
  return prisma.institution.create({
    data: { name: DEFAULT_INSTITUTION_NAME, type: 'HM' },
  });
}

/** Upsert idempotente de StockLocation por estoqueId legado, via LegacyMapping. */
export async function upsertStockLocations(prisma, estoques, institutionId, importBatchId) {
  const estoqueIdToStockLocationId = new Map();
  for (const estoque of estoques) {
    const mapping = await prisma.legacyMapping.findUnique({
      where: { legacyCollection_legacyDocId: { legacyCollection: 'estoques', legacyDocId: estoque.id } },
    });

    const data = { institutionId, name: estoque.data.nome ?? estoque.id, active: estoque.data.ativo !== false };
    const stockLocation = mapping?.stockLocationId
      ? await prisma.stockLocation.update({ where: { id: mapping.stockLocationId }, data })
      : await prisma.stockLocation.create({ data });

    if (!mapping?.stockLocationId) {
      await upsertLegacyMapping(prisma, {
        entityType: 'STOCK_LOCATION',
        legacyCollection: 'estoques',
        legacyDocId: estoque.id,
        stockLocationId: stockLocation.id,
        importBatchId,
      });
    }
    estoqueIdToStockLocationId.set(estoque.id, stockLocation.id);
  }
  return estoqueIdToStockLocationId;
}

/** Upsert idempotente de Product a partir do bucket `auto` do saneamento. */
export async function upsertProducts(prisma, autoItems, importBatchId) {
  const itemIdToProductId = new Map();
  for (const entry of autoItems) {
    const product = await prisma.product.upsert({
      where: { code: entry.product.code },
      create: entry.product,
      update: entry.product,
    });
    await upsertLegacyMapping(prisma, {
      entityType: 'PRODUCT',
      legacyCollection: 'itens',
      legacyDocId: entry.itemId,
      legacyCode: entry.codigo,
      productId: product.id,
      importBatchId,
    });
    itemIdToProductId.set(entry.itemId, product.id);
  }
  return itemIdToProductId;
}

/** Upsert de StockBalance só para saldos cujo produto E local já migraram. */
export async function upsertStockBalances(prisma, saldos, itemIdToProductId, estoqueIdToStockLocationId) {
  const written = [];
  const semCorrespondencia = [];
  for (const saldo of saldos) {
    const productId = itemIdToProductId.get(saldo.data.itemId);
    const stockLocationId = estoqueIdToStockLocationId.get(saldo.data.estoqueId);
    if (!productId || !stockLocationId) {
      semCorrespondencia.push({
        saldoId: saldo.id,
        itemId: saldo.data.itemId,
        estoqueId: saldo.data.estoqueId,
        motivo: !productId ? 'produto-nao-migrado' : 'estoque-nao-migrado',
      });
      continue;
    }
    const quantity = Number(saldo.data.qtd) || 0;
    const balance = await prisma.stockBalance.upsert({
      where: { productId_stockLocationId: { productId, stockLocationId } },
      create: { productId, stockLocationId, quantity },
      update: { quantity },
    });
    written.push({ saldoId: saldo.id, stockBalanceId: balance.id, quantity });
  }
  return { written, semCorrespondencia };
}

/** Lê o total real gravado em StockBalance — usado para reconciliar o
 * relatório com o estado real do banco após um --commit. */
export async function readDestinoReal(prisma) {
  const result = await prisma.stockBalance.aggregate({ _sum: { quantity: true } });
  return { total: Number(result._sum.quantity) || 0, fonte: 'banco (pós-commit)' };
}
