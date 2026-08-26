import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeLegacyItem, classifyLegacyItems } from './saneamento.mjs';
import { emitCommitStatements } from './sql-emit.mjs';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/sample-legacy-data.json'
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

function classificacaoDaFixture() {
  const items = fixture.itens.map(normalizeLegacyItem);
  const saldoTotalPorItemId = new Map();
  for (const saldo of fixture.saldos) {
    saldoTotalPorItemId.set(saldo.itemId, (saldoTotalPorItemId.get(saldo.itemId) ?? 0) + saldo.qtd);
  }
  return classifyLegacyItems(items, saldoTotalPorItemId);
}

test('emite um statement por tabela, nunca um por linha', () => {
  const classificacao = classificacaoDaFixture();
  const statements = emitCommitStatements({
    institutionId: 'inst-1',
    estoques: [{ id: 'e1', nome: 'Estoque de teste', ativo: true }],
    classificacao,
    saldosOrigem: fixture.saldos,
    importBatchId: 'import-teste',
  });
  // StockLocation + LegacyMapping(estoque) + Product + LegacyMapping(item) + StockBalance
  assert.equal(statements.length, 5);
  for (const s of statements) assert.match(s, /^INSERT INTO/);
});

test('todo statement usa ON CONFLICT (idempotente)', () => {
  const classificacao = classificacaoDaFixture();
  const statements = emitCommitStatements({
    institutionId: 'inst-1',
    estoques: [{ id: 'e1', nome: 'Estoque de teste', ativo: true }],
    classificacao,
    saldosOrigem: fixture.saldos,
    importBatchId: 'import-teste',
  });
  for (const s of statements) assert.match(s, /ON CONFLICT/);
});

test('só itens do balde auto viram Product — review nunca migra sozinho', () => {
  const classificacao = classificacaoDaFixture();
  const statements = emitCommitStatements({
    institutionId: 'inst-1',
    estoques: [],
    classificacao,
    saldosOrigem: fixture.saldos,
    importBatchId: 'import-teste',
  });
  const productStatement = statements.find((s) => s.startsWith('INSERT INTO "Product"'));
  // i1 e i8 são os únicos itens auto na fixture (ver saneamento.test.mjs)
  assert.match(productStatement, /"MED0001"|MED0001/);
  assert.match(productStatement, /MED0012/);
  // i2 (codigo-duplicado) não pode aparecer como Product
  assert.doesNotMatch(productStatement, /DIPIRONA/);
});

test('sem estoques, não gera statement de StockLocation (não emite INSERT vazio)', () => {
  const classificacao = classificacaoDaFixture();
  const statements = emitCommitStatements({
    institutionId: 'inst-1',
    estoques: [],
    classificacao,
    saldosOrigem: [],
    importBatchId: 'import-teste',
  });
  assert.ok(!statements.some((s) => s.includes('"StockLocation"')));
  assert.ok(!statements.some((s) => s.includes('"StockBalance"')));
});
