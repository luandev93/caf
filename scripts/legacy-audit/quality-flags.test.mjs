import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flagItensSemCodigo,
  flagItensCodigoDuplicado,
  flagItensCodigoConflitante,
  flagPossivelDuplicataCodigoDiferente,
  flagItensInativosComSaldo,
  flagItensPendentesComSaldo,
  flagRegistrosOrfaos,
  flagDivergenciaSaldoLote,
  flagPessoasComLoginSemAuthUid,
  flagAuthUsersSemPessoa,
} from './quality-flags.mjs';

const item = (id, data) => ({ id, data });

test('flagItensSemCodigo pega itens sem codigo', () => {
  const itens = [item('a', { codigo: 'MED0001' }), item('b', { codigo: '' }), item('c', {})];
  const flags = flagItensSemCodigo(itens);
  assert.deepEqual(flags.map((f) => f.itemId).sort(), ['b', 'c']);
});

test('flagItensCodigoDuplicado agrupa mesmo codigo em docs diferentes', () => {
  const itens = [
    item('a', { codigo: 'MED0001' }),
    item('b', { codigo: 'MED0001' }),
    item('c', { codigo: 'MED0002' }),
  ];
  const flags = flagItensCodigoDuplicado(itens);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].codigo, 'MED0001');
  assert.deepEqual(flags[0].itemIds.sort(), ['a', 'b']);
});

test('flagItensCodigoConflitante só dispara quando descricao diverge', () => {
  const iguais = [
    item('a', { codigo: 'MED0001', descricao: 'Omeprazol 40mg' }),
    item('b', { codigo: 'MED0001', descricao: 'Omeprazol 40mg' }),
  ];
  assert.equal(flagItensCodigoConflitante(iguais).length, 0);

  const divergentes = [
    item('a', { codigo: 'MED0001', descricao: 'Omeprazol 40mg' }),
    item('b', { codigo: 'MED0001', descricao: 'Dipirona 500mg' }),
  ];
  assert.equal(flagItensCodigoConflitante(divergentes).length, 1);
});

test('flagPossivelDuplicataCodigoDiferente pega descricao igual com codigo diferente', () => {
  const itens = [
    item('a', { codigo: 'MED0001', descricao: 'Omeprazol', principioAtivo: 'Omeprazol', concentracao: '40mg' }),
    item('b', { codigo: 'MED0099', descricao: 'Omeprazol', principioAtivo: 'Omeprazol', concentracao: '40mg' }),
  ];
  const flags = flagPossivelDuplicataCodigoDiferente(itens);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].itens.length, 2);
});

test('flagItensInativosComSaldo e flagItensPendentesComSaldo respeitam saldo > 0', () => {
  const itens = [
    item('a', { ativo: false }),
    item('b', { ativo: false }),
    item('c', { pendente: true }),
  ];
  const saldos = [
    { data: { itemId: 'a', qtd: 5 } },
    { data: { itemId: 'b', qtd: 0 } },
    { data: { itemId: 'c', qtd: 3 } },
  ];
  assert.deepEqual(flagItensInativosComSaldo(itens, saldos).map((f) => f.itemId), ['a']);
  assert.deepEqual(flagItensPendentesComSaldo(itens, saldos).map((f) => f.itemId), ['c']);
});

test('flagRegistrosOrfaos detecta itemId/estoqueId inexistentes', () => {
  const saldos = [
    { id: 's1', data: { itemId: 'existe', estoqueId: 'e1' } },
    { id: 's2', data: { itemId: 'nao-existe', estoqueId: 'e1' } },
  ];
  const flags = flagRegistrosOrfaos(saldos, {
    itemIds: new Set(['existe']),
    estoqueIds: new Set(['e1']),
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, 's2');
});

test('flagDivergenciaSaldoLote só flaga quando existem lotes para a chave', () => {
  const saldos = [
    { data: { estoqueId: 'e1', itemId: 'i1', qtd: 10 } },
    { data: { estoqueId: 'e1', itemId: 'i2', qtd: 7 } },
  ];
  const lotes = [{ data: { estoqueId: 'e1', itemId: 'i1', qtd: 8 } }];
  const flags = flagDivergenciaSaldoLote(saldos, lotes);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].chave, 'e1__i1');
  assert.equal(flags[0].diferenca, -2);
});

test('flagPessoasComLoginSemAuthUid e flagAuthUsersSemPessoa são complementares', () => {
  const pessoas = [
    item('uid1', { acesso: { temLogin: true } }),
    item('uid2', { acesso: { temLogin: true } }),
  ];
  const authUsers = [{ uid: 'uid1', email: 'a@a.com' }, { uid: 'uid3', email: 'b@b.com' }];
  assert.deepEqual(flagPessoasComLoginSemAuthUid(pessoas, authUsers).map((f) => f.pessoaId), ['uid2']);
  assert.deepEqual(flagAuthUsersSemPessoa(pessoas, authUsers).map((f) => f.uid), ['uid3']);
});
