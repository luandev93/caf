import { semAcento } from '../lib/legacy-keys.mjs';

const EPSILON = 0.001;

function descricaoNormalizada(data) {
  return semAcento(
    [data.descricao, data.principioAtivo, data.concentracao, data.formaFarmaceutica]
      .filter(Boolean)
      .join(' ')
  );
}

function saldoDoItem(saldosPorItemId, itemId) {
  return saldosPorItemId.get(itemId) ?? 0;
}

// Campos do legado sem coluna equivalente em Product nesta fase (preço,
// fornecedor/contrato, posologia). Não são "descartados silenciosamente":
// já ficam preservados no relatório de auditoria (amostra completa do doc
// Firestore); aqui são só classificados como "preservar no legado por ora",
// já que Supplier/Invoice ainda não existem no schema (ver plano).
const CAMPOS_SEM_DESTINO_AINDA = [
  'posologia',
  'precoMin',
  'precoMax',
  'precoContrato',
  'marca',
  'fornecedor',
  'contrato',
  'codigoContrato',
];

function mapearParaProduct(data) {
  const semDestinoAinda = {};
  for (const campo of CAMPOS_SEM_DESTINO_AINDA) {
    if (data[campo] !== undefined && data[campo] !== null && data[campo] !== '') {
      semDestinoAinda[campo] = data[campo];
    }
  }
  return {
    product: {
      code: data.codigo,
      description: data.descricao,
      activeIngredient: data.principioAtivo || null,
      concentration: data.concentracao || null,
      pharmaceuticalForm: data.formaFarmaceutica || null,
      unit: data.unidade,
      type: data.tipo || null,
      atcGroup: data.grupoATC || null,
      atcGroupName: data.grupoATCNome || null,
      pharmacologicalGroup: data.grupoFarmacologico || null,
      controlled: data.controlado || null,
      thermolabile: Boolean(data.termolabil),
      highAlert: Boolean(data.altaVigilancia),
      minStock: Number(data.estoqueMinimo) || 0,
      controlsBatch: data.controlaLote !== false,
      active: data.ativo !== false,
    },
    // classificação explícita — nunca fica implícito que foi ignorado.
    camposPreservadosNoLegado: semDestinoAinda,
  };
}

/**
 * Regras de saneamento/canonicalização do catálogo legado (ver plano, seção 3).
 * Chave de dedup é sempre `codigo` — nunca nome/descrição isolados.
 *
 * @param {Array<{id: string, data: object}>} itens
 * @param {Map<string, number>} saldosPorItemId soma de saldos.qtd por itemId
 * @returns {{ auto: object[], review: object[], skipped: object[] }}
 */
export function sanearCatalogo(itens, saldosPorItemId) {
  const auto = [];
  const review = [];
  const skipped = [];

  const gruposPorCodigo = new Map();
  for (const item of itens) {
    const codigo = item.data.codigo;
    if (!codigo) {
      review.push({ itemId: item.id, codigo: null, motivo: 'sem-codigo', descricao: item.data.descricao ?? null });
      continue;
    }
    if (!gruposPorCodigo.has(codigo)) gruposPorCodigo.set(codigo, []);
    gruposPorCodigo.get(codigo).push(item);
  }

  // decisões tentativas para os grupos com codigo único (podem ainda virar
  // `review` na segunda passada, por possível duplicata entre códigos).
  const autoTentativo = [];

  for (const [codigo, docs] of gruposPorCodigo) {
    if (docs.length > 1) {
      const descricoesDistintas = new Set(docs.map((d) => descricaoNormalizada(d.data)));
      const motivo = descricoesDistintas.size > 1 ? 'codigo-conflitante' : 'codigo-duplicado';
      review.push({
        codigo,
        motivo,
        itens: docs.map((d) => ({ itemId: d.id, descricao: d.data.descricao ?? null })),
      });
      continue;
    }

    const [item] = docs;
    const saldo = saldoDoItem(saldosPorItemId, item.id);

    if (item.data.pendente === true) {
      if (saldo <= EPSILON) {
        skipped.push({ itemId: item.id, codigo, motivo: 'pendente-sem-saldo' });
      } else {
        review.push({ itemId: item.id, codigo, motivo: 'pendente-com-saldo', saldo });
      }
      continue;
    }

    if (item.data.ativo === false && saldo > EPSILON) {
      review.push({ itemId: item.id, codigo, motivo: 'inativo-com-saldo', saldo });
      continue;
    }

    autoTentativo.push(item);
  }

  // segunda passada: entre os tentativamente AUTO, descrição quase idêntica
  // com codigo diferente nunca é mesclada automaticamente.
  const gruposPorDescricao = new Map();
  for (const item of autoTentativo) {
    const chave = descricaoNormalizada(item.data);
    if (!gruposPorDescricao.has(chave)) gruposPorDescricao.set(chave, []);
    gruposPorDescricao.get(chave).push(item);
  }

  for (const docs of gruposPorDescricao.values()) {
    if (docs.length > 1) {
      review.push({
        motivo: 'possivel-duplicata',
        itens: docs.map((d) => ({ itemId: d.id, codigo: d.data.codigo, descricao: d.data.descricao ?? null })),
      });
      continue;
    }
    const [item] = docs;
    const { product, camposPreservadosNoLegado } = mapearParaProduct(item.data);
    auto.push({ itemId: item.id, codigo: item.data.codigo, product, camposPreservadosNoLegado });
  }

  return { auto, review, skipped };
}
