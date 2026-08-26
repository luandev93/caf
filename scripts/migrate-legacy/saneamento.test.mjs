// Testes puros do saneamento — sem Firestore, sem Postgres, sem rede.
// Roda com `npm test` (node --test), zero dependência extra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeLegacyItem, normalizeDescription, classifyLegacyItems } from './saneamento.mjs';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/sample-legacy-data.json'
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

function classifyFixture() {
  const items = fixture.itens.map(normalizeLegacyItem);
  const saldoTotalPorItemId = new Map();
  for (const saldo of fixture.saldos) {
    saldoTotalPorItemId.set(saldo.itemId, (saldoTotalPorItemId.get(saldo.itemId) ?? 0) + saldo.qtd);
  }
  return classifyLegacyItems(items, saldoTotalPorItemId);
}

test('normalizeDescription ignora acento, caixa e espaço duplicado', () => {
  assert.equal(normalizeDescription('  Paracetamol  500mg cp '), 'PARACETAMOL 500MG CP');
  assert.equal(normalizeDescription('DIPIRONA SÓDICA'), 'DIPIRONA SODICA');
});

test('item com código único e sem pendências vai para auto', () => {
  const { auto } = classifyFixture();
  const ids = auto.map((i) => i.id);
  assert.ok(ids.includes('i1'), 'MED0001 deveria ser auto');
});

test('item inativo sem saldo continua auto (inatividade sozinha não bloqueia)', () => {
  const { auto } = classifyFixture();
  assert.ok(auto.map((i) => i.id).includes('i8'));
});

test('código duplicado entre docs manda AMBOS para revisão', () => {
  const { review } = classifyFixture();
  const porId = new Map(review.map((r) => [r.item.id, r.motivos]));
  assert.deepEqual(porId.get('i2'), ['codigo-duplicado']);
  assert.deepEqual(porId.get('i4'), ['codigo-duplicado']);
});

test('item sem código vai para revisão com motivo sem-codigo', () => {
  const { review } = classifyFixture();
  const i3 = review.find((r) => r.item.id === 'i3');
  assert.deepEqual(i3.motivos, ['sem-codigo']);
});

test('pendente com saldo > 0 vai para revisão, nunca é excluído', () => {
  const { review, excluido } = classifyFixture();
  assert.ok(review.some((r) => r.item.id === 'i5' && r.motivos.includes('pendente-com-saldo')));
  assert.ok(!excluido.some((e) => e.item.id === 'i5'));
});

test('pendente sem saldo é excluído do baseline (nunca silenciosamente ignorado)', () => {
  const { excluido } = classifyFixture();
  const i6 = excluido.find((e) => e.item.id === 'i6');
  assert.deepEqual(i6.motivos, ['pendente-sem-saldo']);
});

test('inativo com saldo > 0 vai para revisão (estoque real não pode sumir)', () => {
  const { review } = classifyFixture();
  const i7 = review.find((r) => r.item.id === 'i7');
  assert.deepEqual(i7.motivos, ['inativo-com-saldo']);
});

test('descrições iguais pós-normalização com códigos diferentes viram possível duplicata', () => {
  const { review } = classifyFixture();
  const ids = review.filter((r) => r.motivos.includes('possivel-duplicata')).map((r) => r.item.id);
  assert.deepEqual(ids.sort(), ['i10', 'i9']);
});

test('todo item de entrada aparece em exatamente um balde de saída', () => {
  const { auto, review, excluido } = classifyFixture();
  const total = auto.length + review.length + excluido.length;
  assert.equal(total, fixture.itens.length);
});
