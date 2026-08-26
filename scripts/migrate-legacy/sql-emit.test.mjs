import test from 'node:test';
import assert from 'node:assert/strict';
import { emitMigrationSql, emitBulkMigrationSql } from './sql-emit.mjs';

const auto = [
  {
    itemId: 'i1',
    codigo: 'MED0001',
    product: {
      code: 'MED0001', description: "Omeprazol's 40mg", activeIngredient: 'Omeprazol', concentration: '40mg',
      pharmaceuticalForm: 'Injetável', unit: 'AMPOLA', type: 'MEDICAMENTO', atcGroup: null, atcGroupName: null,
      pharmacologicalGroup: null, controlled: null, thermolabile: false, highAlert: false, minStock: 0,
      controlsBatch: true, active: true,
    },
  },
];
const estoques = [{ id: 'e1', data: { nome: 'Central', ativo: true } }];
const saldos = [
  { id: 's1', data: { estoqueId: 'e1', itemId: 'i1', qtd: 10 } },
  { id: 's2', data: { estoqueId: 'e1', itemId: 'inexistente', qtd: 3 } },
];

test('emitMigrationSql gera statements para institution/estoque/produto/saldo e escapa aspas', () => {
  const { statements, semCorrespondencia } = emitMigrationSql({ auto, estoques, saldos, importBatchId: 'test-batch' });
  // Institution + StockLocation + LegacyMapping(estoque) + Product + LegacyMapping(produto) + StockBalance(s1; s2 sem produto)
  assert.equal(statements.length, 6);
  assert.ok(statements.some((s) => s.includes("Omeprazol''s 40mg")));
  assert.equal(semCorrespondencia.length, 1);
  assert.equal(semCorrespondencia[0].motivo, 'produto-nao-migrado');
});

test('ids determinísticos são estáveis entre chamadas (idempotência)', () => {
  const a = emitMigrationSql({ auto, estoques, saldos: [], importBatchId: 'b1' });
  const b = emitMigrationSql({ auto, estoques, saldos: [], importBatchId: 'b2' });
  assert.equal(a.ids.institutionId, b.ids.institutionId);
  assert.equal(a.ids.itemIdToProductId.get('i1'), b.ids.itemIdToProductId.get('i1'));
  assert.equal(a.ids.estoqueIdToStockLocationId.get('e1'), b.ids.estoqueIdToStockLocationId.get('e1'));
});

test('emitBulkMigrationSql produz o mesmo resultado lógico que emitMigrationSql, em menos statements', () => {
  const individual = emitMigrationSql({ auto, estoques, saldos, importBatchId: 'bulk-test' });
  const bulk = emitBulkMigrationSql({ auto, estoques, saldos, importBatchId: 'bulk-test', batchSize: 40 });
  assert.equal(bulk.ids.institutionId, individual.ids.institutionId);
  assert.equal(bulk.semCorrespondencia.length, 1);
  // 1 dataset pequeno cabe tudo em 1 statement por tabela: Institution, StockLocation, LegacyMapping(estoque), Product, LegacyMapping(produto), StockBalance
  assert.equal(bulk.statements.length, 6);
  assert.ok(bulk.statements.some((s) => s.startsWith('INSERT INTO "Product"') && s.includes('VALUES (') && s.includes("Omeprazol''s 40mg")));
});

test('emitBulkMigrationSql agrupa em lotes de batchSize e mantém idempotência (mesmos ids em reemissões)', () => {
  const manyAuto = Array.from({ length: 95 }, (_, i) => ({
    itemId: `item-${i}`,
    codigo: `MED${String(i).padStart(4, '0')}`,
    product: { ...auto[0].product, code: `MED${String(i).padStart(4, '0')}`, description: `Produto ${i}` },
  }));
  const a = emitBulkMigrationSql({ auto: manyAuto, estoques, saldos: [], importBatchId: 'batch-a', batchSize: 40 });
  const b = emitBulkMigrationSql({ auto: manyAuto, estoques, saldos: [], importBatchId: 'batch-b', batchSize: 40 });
  // 95 produtos / 40 por lote = 3 lotes de Product + 3 de LegacyMapping(produto), + Institution + StockLocation + LegacyMapping(estoque)
  const productStmts = a.statements.filter((s) => s.startsWith('INSERT INTO "Product"'));
  assert.equal(productStmts.length, 3);
  assert.equal(a.ids.itemIdToProductId.get('item-0'), b.ids.itemIdToProductId.get('item-0'));
  assert.equal(a.ids.itemIdToProductId.get('item-94'), b.ids.itemIdToProductId.get('item-94'));
});
