import test from 'node:test';
import assert from 'node:assert/strict';
import { sanearCatalogo } from './saneamento.mjs';

const item = (id, data) => ({ id, data });

// Fixtures reais extraídas de farm/src/data/catalogo.json (seed do catálogo legado).
const OMEPRAZOL_INJ = {
  codigo: 'MED0001',
  descricao: 'OMEPRAZOL 40MG INJ.',
  principioAtivo: 'Omeprazol',
  concentracao: '40mg Inj.',
  formaFarmaceutica: 'Injetável',
  unidade: 'AMPOLA',
  tipo: 'MEDICAMENTO',
  grupoATC: 'A',
  grupoATCNome: 'Aparelho Digestivo e Metabolismo',
  grupoFarmacologico: 'Inibidores da Bomba de Prótons',
  posologia: '40mg EV 1x/dia',
  controlado: '',
  termolabil: false,
  altaVigilancia: false,
  precoMin: 2.82,
  precoMax: 3.39,
  precoContrato: null,
  marca: '',
  fornecedor: '',
  contrato: '',
  codigoContrato: '',
  estoqueMinimo: 0,
  controlaLote: true,
  ativo: true,
};

const OMEPRAZOL_CP = {
  ...OMEPRAZOL_INJ,
  codigo: 'MED0002',
  descricao: 'OMEPRAZOL 20MG CP',
  concentracao: '20mg Cp',
  formaFarmaceutica: 'Comprimido',
  unidade: 'COMPRIMIDO',
  posologia: '20mg VO 1x/dia',
  precoMin: 0.33,
  precoMax: 0.4,
};

test('item com codigo unico e sem pendencias vai para auto, mapeado para Product', () => {
  const { auto, review, skipped } = sanearCatalogo([item('a', OMEPRAZOL_INJ)], new Map());
  assert.equal(review.length, 0);
  assert.equal(skipped.length, 0);
  assert.equal(auto.length, 1);
  assert.equal(auto[0].product.code, 'MED0001');
  assert.equal(auto[0].product.description, 'OMEPRAZOL 40MG INJ.');
  assert.equal(auto[0].product.unit, 'AMPOLA');
  assert.equal(auto[0].product.controlsBatch, true);
  assert.equal(auto[0].product.active, true);
  // preço/fornecedor/posologia não têm coluna ainda — preservados, não descartados.
  assert.equal(auto[0].camposPreservadosNoLegado.posologia, '40mg EV 1x/dia');
});

test('itens com apresentacoes diferentes (mesma substancia, codigo diferente) não são fundidos', () => {
  const { auto, review } = sanearCatalogo(
    [item('a', OMEPRAZOL_INJ), item('b', OMEPRAZOL_CP)],
    new Map()
  );
  assert.equal(review.length, 0);
  assert.equal(auto.length, 2);
});

test('item sem codigo vai para review', () => {
  const { review, auto } = sanearCatalogo([item('a', { ...OMEPRAZOL_INJ, codigo: '' })], new Map());
  assert.equal(auto.length, 0);
  assert.equal(review.length, 1);
  assert.equal(review[0].motivo, 'sem-codigo');
});

test('mesmo codigo em dois docs com descricoes iguais vai para review (codigo-duplicado)', () => {
  const { review, auto } = sanearCatalogo(
    [item('a', OMEPRAZOL_INJ), item('b', OMEPRAZOL_INJ)],
    new Map()
  );
  assert.equal(auto.length, 0);
  assert.equal(review.length, 1);
  assert.equal(review[0].motivo, 'codigo-duplicado');
});

test('mesmo codigo com descricoes divergentes vai para review (codigo-conflitante)', () => {
  const { review } = sanearCatalogo(
    [item('a', OMEPRAZOL_INJ), item('b', { ...OMEPRAZOL_INJ, descricao: 'Dipirona 500mg' })],
    new Map()
  );
  assert.equal(review.length, 1);
  assert.equal(review[0].motivo, 'codigo-conflitante');
});

test('descricao quase identica com codigo diferente vira possivel-duplicata, nunca mesclada', () => {
  const duplicataComOutroCodigo = { ...OMEPRAZOL_INJ, codigo: 'MED9999' };
  const { auto, review } = sanearCatalogo(
    [item('a', OMEPRAZOL_INJ), item('b', duplicataComOutroCodigo)],
    new Map()
  );
  assert.equal(auto.length, 0);
  assert.equal(review.length, 1);
  assert.equal(review[0].motivo, 'possivel-duplicata');
  assert.equal(review[0].itens.length, 2);
});

test('item pendente sem saldo é excluido do baseline (skipped)', () => {
  const { skipped, auto, review } = sanearCatalogo(
    [item('a', { ...OMEPRAZOL_INJ, pendente: true })],
    new Map()
  );
  assert.equal(auto.length, 0);
  assert.equal(review.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].motivo, 'pendente-sem-saldo');
});

test('item pendente com saldo > 0 não pode sumir estoque real: vai para review', () => {
  const saldos = new Map([['a', 5]]);
  const { review, skipped } = sanearCatalogo([item('a', { ...OMEPRAZOL_INJ, pendente: true })], saldos);
  assert.equal(skipped.length, 0);
  assert.equal(review.length, 1);
  assert.equal(review[0].motivo, 'pendente-com-saldo');
});

test('item inativo sem saldo vai automaticamente com active=false', () => {
  const { auto } = sanearCatalogo([item('a', { ...OMEPRAZOL_INJ, ativo: false })], new Map());
  assert.equal(auto.length, 1);
  assert.equal(auto[0].product.active, false);
});

test('item inativo com saldo > 0 vai para review, não some estoque real', () => {
  const saldos = new Map([['a', 3]]);
  const { review, auto } = sanearCatalogo([item('a', { ...OMEPRAZOL_INJ, ativo: false })], saldos);
  assert.equal(auto.length, 0);
  assert.equal(review.length, 1);
  assert.equal(review[0].motivo, 'inativo-com-saldo');
});
