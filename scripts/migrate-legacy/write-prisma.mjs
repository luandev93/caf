// Caminho de commit via @prisma/client — usa conexão TCP direta com o
// Postgres. Funciona em CI e em máquina local; NÃO funciona num sandbox que
// só sai por proxy HTTPS (ver sql-emit.mjs para esse caso, que gera os
// mesmos efeitos como statements pra rodar via Neon MCP).
//
// Mesma lógica de idempotência do sql-emit.mjs: upsert por chave natural
// (Product.code, StockBalance productId+stockLocationId, LegacyMapping
// legacyCollection+legacyDocId) em vez de sempre inserir.
import { productId, stockLocationId, stockBalanceId, legacyMappingId } from './ids.mjs';

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} params ver sql-emit.mjs para o shape de cada campo
 */
export async function commitToDatabase(prisma, { institutionId, estoques, classificacao, saldosOrigem, importBatchId }) {
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    for (const estoque of estoques) {
      const id = stockLocationId(estoque.id);
      await tx.stockLocation.upsert({
        where: { id },
        create: { id, institutionId, name: estoque.nome, active: estoque.ativo ?? true },
        update: { name: estoque.nome, active: estoque.ativo ?? true },
      });
      await tx.legacyMapping.upsert({
        where: { legacyCollection_legacyDocId: { legacyCollection: 'estoques', legacyDocId: estoque.id } },
        create: {
          id: legacyMappingId('estoques', estoque.id),
          entityType: 'STOCK_LOCATION',
          legacyCollection: 'estoques',
          legacyDocId: estoque.id,
          stockLocationId: id,
          importBatchId,
          importedAt: now,
        },
        update: { stockLocationId: id },
      });
    }

    for (const item of classificacao.auto) {
      const id = productId(item.codigo);
      await tx.product.upsert({
        where: { code: item.codigo },
        create: {
          id,
          code: item.codigo,
          description: item.descricao,
          active: item.ativo,
          unit: item.unidade ?? 'UNIDADE',
          type: item.tipo,
        },
        update: { description: item.descricao, active: item.ativo },
      });
      await tx.legacyMapping.upsert({
        where: { legacyCollection_legacyDocId: { legacyCollection: 'itens', legacyDocId: item.id } },
        create: {
          id: legacyMappingId('itens', item.id),
          entityType: 'PRODUCT',
          legacyCollection: 'itens',
          legacyDocId: item.id,
          legacyCode: item.codigo,
          productId: id,
          importBatchId,
          importedAt: now,
        },
        update: { productId: id },
      });
    }

    const codigoPorItemId = new Map(classificacao.auto.map((item) => [item.id, item.codigo]));
    for (const saldo of saldosOrigem) {
      const codigo = codigoPorItemId.get(saldo.itemId);
      if (!codigo) continue;
      const pId = productId(codigo);
      const slId = stockLocationId(saldo.estoqueId);
      await tx.stockBalance.upsert({
        where: { productId_stockLocationId: { productId: pId, stockLocationId: slId } },
        create: { id: stockBalanceId(codigo, saldo.estoqueId), productId: pId, stockLocationId: slId, quantity: saldo.qtd },
        update: { quantity: saldo.qtd },
      });
    }
  });
}
