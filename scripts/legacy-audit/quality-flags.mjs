import { semAcento, chaveSaldo } from '../lib/legacy-keys.mjs';

const EPSILON = 0.001;

function descricaoNormalizada(item) {
  return semAcento(
    [item.descricao, item.principioAtivo, item.concentracao, item.formaFarmaceutica]
      .filter(Boolean)
      .join(' ')
  );
}

function agrupar(lista, chaveFn) {
  const grupos = new Map();
  for (const el of lista) {
    const chave = chaveFn(el);
    if (!chave) continue;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(el);
  }
  return grupos;
}

/** itens.itens sem `codigo` — não podem virar Product automaticamente. */
export function flagItensSemCodigo(itens) {
  return itens
    .filter((i) => !i.data.codigo)
    .map((i) => ({ itemId: i.id, descricao: i.data.descricao ?? null }));
}

/** Mesmo `codigo` usado em mais de um documento (Firestore não garante unicidade). */
export function flagItensCodigoDuplicado(itens) {
  const grupos = agrupar(
    itens.filter((i) => i.data.codigo),
    (i) => i.data.codigo
  );
  const flags = [];
  for (const [codigo, docs] of grupos) {
    if (docs.length > 1) {
      flags.push({ codigo, itemIds: docs.map((d) => d.id) });
    }
  }
  return flags;
}

/** Mesmo `codigo`, mas descrição/campos divergentes entre os documentos duplicados. */
export function flagItensCodigoConflitante(itens) {
  const duplicados = flagItensCodigoDuplicado(itens);
  const porId = new Map(itens.map((i) => [i.id, i]));
  const flags = [];
  for (const { codigo, itemIds } of duplicados) {
    const descricoes = new Set(itemIds.map((id) => descricaoNormalizada(porId.get(id).data)));
    if (descricoes.size > 1) {
      flags.push({
        codigo,
        itemIds,
        descricoes: itemIds.map((id) => porId.get(id).data.descricao ?? null),
      });
    }
  }
  return flags;
}

/** Descrição/princípio ativo/concentração quase idênticos, mas `codigo` diferente
 * — candidato a duplicata real, nunca mesclado automaticamente. */
export function flagPossivelDuplicataCodigoDiferente(itens) {
  const grupos = agrupar(
    itens.filter((i) => i.data.codigo && i.data.descricao),
    (i) => descricaoNormalizada(i.data)
  );
  const flags = [];
  for (const docs of grupos.values()) {
    const codigos = new Set(docs.map((d) => d.data.codigo));
    if (codigos.size > 1) {
      flags.push({
        descricaoNormalizada: descricaoNormalizada(docs[0].data),
        itens: docs.map((d) => ({ itemId: d.id, codigo: d.data.codigo, descricao: d.data.descricao })),
      });
    }
  }
  return flags;
}

function saldoPorItem(saldos) {
  const total = new Map();
  for (const s of saldos) {
    const qtd = Number(s.data.qtd) || 0;
    total.set(s.data.itemId, (total.get(s.data.itemId) ?? 0) + qtd);
  }
  return total;
}

/** itens.ativo=false mas ainda com saldo > 0 em algum estoque. */
export function flagItensInativosComSaldo(itens, saldos) {
  const totais = saldoPorItem(saldos);
  return itens
    .filter((i) => i.data.ativo === false && (totais.get(i.id) ?? 0) > EPSILON)
    .map((i) => ({ itemId: i.id, descricao: i.data.descricao ?? null, saldoTotal: totais.get(i.id) }));
}

/** itens.pendente=true (nunca aprovado) mas já com saldo > 0 — não pode sumir estoque real. */
export function flagItensPendentesComSaldo(itens, saldos) {
  const totais = saldoPorItem(saldos);
  return itens
    .filter((i) => i.data.pendente === true && (totais.get(i.id) ?? 0) > EPSILON)
    .map((i) => ({ itemId: i.id, descricao: i.data.descricao ?? null, saldoTotal: totais.get(i.id) }));
}

/** saldos/lotes que referenciam um itemId ou estoqueId inexistente. */
export function flagRegistrosOrfaos(registros, { itemIds, estoqueIds }) {
  return registros
    .filter((r) => !itemIds.has(r.data.itemId) || !estoqueIds.has(r.data.estoqueId))
    .map((r) => ({
      id: r.id,
      itemId: r.data.itemId,
      estoqueId: r.data.estoqueId,
      itemExiste: itemIds.has(r.data.itemId),
      estoqueExiste: estoqueIds.has(r.data.estoqueId),
    }));
}

/** Divergência entre soma dos lotes e o saldo consolidado, por estoque+item —
 * só flagado quando existe pelo menos um lote para a chave (itens sem
 * controle de lote nunca deveriam ter lotes e não são uma divergência). */
export function flagDivergenciaSaldoLote(saldos, lotes) {
  const saldoPorChave = new Map(
    saldos.map((s) => [chaveSaldo(s.data.estoqueId, s.data.itemId), Number(s.data.qtd) || 0])
  );
  const lotesPorChave = agrupar(lotes, (l) => chaveSaldo(l.data.estoqueId, l.data.itemId));

  const flags = [];
  for (const [chave, docs] of lotesPorChave) {
    const somaLotes = docs.reduce((acc, l) => acc + (Number(l.data.qtd) || 0), 0);
    const saldo = saldoPorChave.get(chave) ?? 0;
    if (Math.abs(somaLotes - saldo) > EPSILON) {
      flags.push({ chave, somaLotes, saldo, diferenca: somaLotes - saldo, quantidadeLotes: docs.length });
    }
  }
  return flags;
}

/** pessoas com acesso.temLogin=true cujo doc id (= uid esperado) não existe
 * no Firebase Auth. */
export function flagPessoasComLoginSemAuthUid(pessoas, authUsers) {
  const uids = new Set(authUsers.map((u) => u.uid));
  return pessoas
    .filter((p) => p.data.acesso?.temLogin === true && !uids.has(p.id))
    .map((p) => ({ pessoaId: p.id, nome: p.data.nome ?? null }));
}

/** contas do Firebase Auth sem uma pessoa correspondente com temLogin=true. */
export function flagAuthUsersSemPessoa(pessoas, authUsers) {
  const pessoasComLogin = new Set(
    pessoas.filter((p) => p.data.acesso?.temLogin === true).map((p) => p.id)
  );
  return authUsers
    .filter((u) => !pessoasComLogin.has(u.uid))
    .map((u) => ({ uid: u.uid, email: u.email, disabled: u.disabled }));
}

export function buildAllFlags({ itens, saldos, lotes, estoques, pessoas, authUsers }) {
  const itemIds = new Set(itens.map((i) => i.id));
  const estoqueIds = new Set(estoques.map((e) => e.id));

  return {
    itensSemCodigo: flagItensSemCodigo(itens),
    itensCodigoDuplicado: flagItensCodigoDuplicado(itens),
    itensCodigoConflitante: flagItensCodigoConflitante(itens),
    possivelDuplicataCodigoDiferente: flagPossivelDuplicataCodigoDiferente(itens),
    itensInativosComSaldo: flagItensInativosComSaldo(itens, saldos),
    itensPendentesComSaldo: flagItensPendentesComSaldo(itens, saldos),
    saldosOrfaos: flagRegistrosOrfaos(saldos, { itemIds, estoqueIds }),
    lotesOrfaos: flagRegistrosOrfaos(lotes, { itemIds, estoqueIds }),
    divergenciaSaldoLote: flagDivergenciaSaldoLote(saldos, lotes),
    pessoasComLoginSemAuthUid: flagPessoasComLoginSemAuthUid(pessoas, authUsers),
    authUsersSemPessoa: flagAuthUsersSemPessoa(pessoas, authUsers),
  };
}
