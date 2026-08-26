// Caminho de commit que NÃO depende de conexão TCP direta com o Postgres.
//
// Por quê: @prisma/client (e `prisma db push`) precisam de uma conexão TCP
// direta com o Neon. Em ambientes sandbox que só têm saída via proxy HTTPS,
// isso falha com P1001 mesmo com a connection string correta. A ferramenta
// Neon (MCP) não tem essa limitação — conecta por HTTPS e já foi o que
// aplicou o schema Prisma na branch `dev/legacy-import` (ver README).
//
// Este módulo gera os MESMOS efeitos que write-prisma.mjs, mas como uma
// lista de statements SQL prontos pra rodar via `mcp__Neon__run_sql_transaction`
// dentro de uma sessão Claude — sem precisar de "rodar isso na sua máquina
// ou no CI". write-prisma.mjs continua existindo para quando o pipeline
// rodar num lugar com TCP de verdade (CI, máquina local).
//
// Idempotente por construção: todo INSERT usa ON CONFLICT nas colunas que já
// são únicas no schema (Product.code, StockBalance(productId,stockLocationId),
// LegacyMapping(legacyCollection,legacyDocId)) — rodar duas vezes com o
// mesmo lote não duplica nem falha.
import { productId, stockLocationId, stockBalanceId, legacyMappingId } from './ids.mjs';

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlBool(value) {
  return value ? 'TRUE' : 'FALSE';
}

function sqlNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Valor numérico inválido: ${value}`);
  return String(n);
}

/**
 * @param {object} params
 * @param {string} params.institutionId Institution já existente no destino.
 * @param {{id:string, nome:string, ativo?:boolean}[]} params.estoques
 * @param {ReturnType<typeof import('./saneamento.mjs').classifyLegacyItems>} params.classificacao
 * @param {{itemId:string, estoqueId:string, qtd:number}[]} params.saldosOrigem
 * @param {string} params.importBatchId identifica esta execução (auditável, reexecutável)
 */
export function emitCommitStatements({ institutionId, estoques, classificacao, saldosOrigem, importBatchId }) {
  const statements = [];
  const now = new Date().toISOString();

  // --- StockLocation (substitui `estoques`) --------------------------------
  for (const estoque of estoques) {
    const id = stockLocationId(estoque.id);
    statements.push(
      `INSERT INTO "StockLocation" (id, "institutionId", name, active, "createdAt", "updatedAt") ` +
        `VALUES (${sqlString(id)}, ${sqlString(institutionId)}, ${sqlString(estoque.nome)}, ` +
        `${sqlBool(estoque.ativo ?? true)}, ${sqlString(now)}, ${sqlString(now)}) ` +
        `ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, "updatedAt" = EXCLUDED."updatedAt";`
    );
    statements.push(
      `INSERT INTO "LegacyMapping" (id, "entityType", "legacyCollection", "legacyDocId", "stockLocationId", "importBatchId", "importedAt") ` +
        `VALUES (${sqlString(legacyMappingId('estoques', estoque.id))}, 'STOCK_LOCATION', 'estoques', ${sqlString(estoque.id)}, ` +
        `${sqlString(id)}, ${sqlString(importBatchId)}, ${sqlString(now)}) ` +
        `ON CONFLICT ("legacyCollection", "legacyDocId") DO UPDATE SET "stockLocationId" = EXCLUDED."stockLocationId";`
    );
  }

  // --- Product (só o balde `auto` — review/excluído nunca migram sozinhos) -
  for (const item of classificacao.auto) {
    const id = productId(item.codigo);
    statements.push(
      `INSERT INTO "Product" (id, code, description, active, unit, type, "createdAt", "updatedAt") ` +
        `VALUES (${sqlString(id)}, ${sqlString(item.codigo)}, ${sqlString(item.descricao)}, ` +
        `${sqlBool(item.ativo)}, ${sqlString(item.unidade ?? 'UNIDADE')}, ${sqlString(item.tipo)}, ` +
        `${sqlString(now)}, ${sqlString(now)}) ` +
        `ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, active = EXCLUDED.active, "updatedAt" = EXCLUDED."updatedAt";`
    );
    statements.push(
      `INSERT INTO "LegacyMapping" (id, "entityType", "legacyCollection", "legacyDocId", "legacyCode", "productId", "importBatchId", "importedAt") ` +
        `VALUES (${sqlString(legacyMappingId('itens', item.id))}, 'PRODUCT', 'itens', ${sqlString(item.id)}, ` +
        `${sqlString(item.codigo)}, ${sqlString(id)}, ${sqlString(importBatchId)}, ${sqlString(now)}) ` +
        `ON CONFLICT ("legacyCollection", "legacyDocId") DO UPDATE SET "productId" = EXCLUDED."productId";`
    );
  }

  // --- StockBalance (só linhas cujo item está no balde `auto`) -------------
  const codigoPorItemId = new Map(classificacao.auto.map((item) => [item.id, item.codigo]));
  for (const saldo of saldosOrigem) {
    const codigo = codigoPorItemId.get(saldo.itemId);
    if (!codigo) continue; // item em review/excluído: saldo fica de fora até a revisão terminar
    const pId = productId(codigo);
    const slId = stockLocationId(saldo.estoqueId);
    statements.push(
      `INSERT INTO "StockBalance" (id, "productId", "stockLocationId", quantity, "updatedAt") ` +
        `VALUES (${sqlString(stockBalanceId(codigo, saldo.estoqueId))}, ${sqlString(pId)}, ${sqlString(slId)}, ` +
        `${sqlNumber(saldo.qtd)}, ${sqlString(now)}) ` +
        `ON CONFLICT ("productId", "stockLocationId") DO UPDATE SET quantity = EXCLUDED.quantity, "updatedAt" = EXCLUDED."updatedAt";`
    );
  }

  return statements;
}
