import { countDocuments, iterateDocuments, listAllAuthUsers } from '../../lib/firebase-admin-client.mjs';

const SAMPLE_SIZE = 5;

/**
 * `full: true` para coleções cujos documentos entram nas quality-flags
 * (itens/saldos/lotes/estoques/pessoas) — precisam do conjunto completo.
 * Para coleções só informativas (movimentos, logs, etc., potencialmente
 * grandes e fora do escopo de recuperação) baixamos apenas uma amostra,
 * evitando ler uma ledger inteira só para contar linhas.
 */
async function collect(collectionName, { full = false } = {}) {
  const count = await countDocuments(collectionName);
  const docs = [];
  for await (const doc of iterateDocuments(collectionName, { pageSize: full ? 500 : SAMPLE_SIZE })) {
    docs.push(doc);
    if (!full && docs.length >= SAMPLE_SIZE) break;
  }
  return { collectionName, count, docs, isFullSet: full };
}

export const collectItens = () => collect('itens', { full: true });
export const collectSaldos = () => collect('saldos', { full: true });
export const collectLotes = () => collect('lotes', { full: true });
export const collectEstoques = () => collect('estoques', { full: true });
export const collectPessoas = () => collect('pessoas', { full: true });
export const collectUsuarios = () => collect('usuarios');
export const collectMovimentos = () => collect('movimentos');
export const collectProfissionais = () => collect('profissionais');
export const collectCatalogoPublico = () => collect('catalogoPublico');
export const collectSolicitacoes = () => collect('solicitacoes');
export const collectEmprestimos = () => collect('emprestimos');
export const collectLogs = () => collect('logs');

export const collectAuthUsers = () => listAllAuthUsers();

export const COLLECTORS = {
  itens: collectItens,
  saldos: collectSaldos,
  lotes: collectLotes,
  estoques: collectEstoques,
  pessoas: collectPessoas,
  usuarios: collectUsuarios,
  movimentos: collectMovimentos,
  profissionais: collectProfissionais,
  catalogoPublico: collectCatalogoPublico,
  solicitacoes: collectSolicitacoes,
  emprestimos: collectEmprestimos,
  logs: collectLogs,
};
