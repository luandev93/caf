// IDs determinísticos (UUID v5) em vez de aleatórios: rodar a migração de
// novo — dry-run ou commit — gera sempre os mesmos ids para o mesmo dado de
// origem. Isso é o que torna write-prisma.mjs e sql-emit.mjs idempotentes
// via upsert, sem precisar de uma tabela de lookup id-antigo -> id-novo.
import { v5 as uuidv5 } from 'uuid';

// Namespace fixo do projeto `caf` — gerado uma única vez (uuid v4) e nunca
// mais alterado. Trocar isso muda todos os ids gerados.
const CAF_NAMESPACE = 'b4b3e6a0-2f2b-4b7c-9c1a-1f2f6a2b6e10';

export const productId = (codigo) => uuidv5(`product:${codigo}`, CAF_NAMESPACE);
export const stockLocationId = (estoqueId) => uuidv5(`stock-location:${estoqueId}`, CAF_NAMESPACE);
export const stockBalanceId = (productCode, estoqueId) =>
  uuidv5(`stock-balance:${productCode}:${estoqueId}`, CAF_NAMESPACE);
export const legacyMappingId = (legacyCollection, legacyDocId) =>
  uuidv5(`legacy-mapping:${legacyCollection}:${legacyDocId}`, CAF_NAMESPACE);
