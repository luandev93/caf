// Caminho de commit que NÃO depende de conexão TCP direta com o Postgres.
//
// Por quê: @prisma/client (e `prisma db push`) precisam de conexão TCP
// direta com o Neon. Em ambientes sandbox que só têm saída via proxy HTTPS,
// isso falha com P1001 mesmo com a connection string correta. A ferramenta
// Neon (MCP) não tem essa limitação — conecta por HTTPS e já foi o que
// aplicou o schema Prisma na branch `dev/legacy-import` (ver README).
//
// Este módulo gera os MESMOS efeitos que write-prisma.mjs, mas como um
// punhado de statements SQL prontos pra rodar via
// `mcp__Neon__run_sql_transaction` dentro de uma sessão Claude.
//
// Um statement por tabela, não um por linha: cada lote (StockLocation,
// Product, StockBalance, mais um LegacyMapping por entidade) vira um único
// `INSERT ... SELECT * FROM json_to_recordset($tag$[...]$tag$) AS t(...)`.
//
// Idempotência real: NUNCA confia num id calculado localmente (UUID v5) pra
// dizer se uma entidade "já existe" — outra execução, outra sessão, ou o
// write-prisma.mjs podem ter criado a mesma entidade com um id diferente.
// A fonte da verdade de "isso já foi importado antes" é sempre
// `LegacyMapping` (chave natural: legacyCollection + legacyDocId) ou uma
// coluna com constraint UNIQUE de verdade (Product.code). O id gerado aqui
// só é usado como fallback pra entidade genuinamente nova.
import { productId, stockLocationId, stockBalanceId, legacyMappingId } from './ids.mjs';

// Dollar-quoting evita ter que escapar aspas dentro do JSON manualmente —
// mais simples e mais seguro do que montar literais string por
// concatenação. O tag só precisaria mudar se, por acaso, aparecesse como
// substring literal nos dados (nunca aconteceu com descrição de produto
// farmacêutico, mas o assert abaixo é o que garante isso em vez de assumir).
function jsonLiteral(value) {
  const tag = '$json$';
  const json = JSON.stringify(value);
  if (json.includes(tag)) throw new Error('Dado contém o delimitador dollar-quote — ajuste o tag em jsonLiteral().');
  return `${tag}${json}${tag}`;
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Parte um array em pedaços de até `size` — cada pedaço vira um statement
 * separado, pra nenhum INSERT sozinho crescer sem limite com o tamanho do
 * catálogo (importante tanto pra quem aplica isso via ferramenta com um
 * teto de texto por chamada, quanto pro tamanho de uma transação no Postgres). */
function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

const MAX_ROWS_PER_STATEMENT = 150;

/**
 * @param {object} params
 * @param {string} params.institutionId Institution já existente no destino.
 * @param {{id:string, nome:string, ativo?:boolean}[]} params.estoques
 * @param {ReturnType<typeof import('./saneamento.mjs').classifyLegacyItems>} params.classificacao
 * @param {{itemId:string, estoqueId:string, qtd:number}[]} params.saldosOrigem
 *   Espera-se `qtd` já numérica e válida (ver quantidadeValida em ../shared/quantidade.mjs).
 * @param {string} params.importBatchId identifica esta execução (auditável, reexecutável)
 */
export function emitCommitStatements({ institutionId, estoques, classificacao, saldosOrigem, importBatchId }) {
  const statements = [];

  // --- StockLocation (substitui `estoques`) --------------------------------
  // COALESCE com o id já registrado em LegacyMapping: se este legacyDocId já
  // foi importado antes (nesta sessão ou em outra), reusa o StockLocation
  // que já existe em vez de assumir que meu id calculado é o real — só uma
  // entidade nova de verdade usa o id gerado aqui.
  if (estoques.length > 0) {
    const rows = estoques.map((e) => ({
      id: stockLocationId(e.id),
      legacyDocId: e.id,
      name: e.nome,
      active: e.ativo ?? true,
    }));
    statements.push(
      `INSERT INTO "StockLocation" (id, "institutionId", name, active, "createdAt", "updatedAt") ` +
        `SELECT COALESCE(lm."stockLocationId", t.id), ${sqlString(institutionId)}, t.name, t.active, now(), now() ` +
        `FROM json_to_recordset(${jsonLiteral(rows)}) AS t(id text, "legacyDocId" text, name text, active boolean) ` +
        `LEFT JOIN "LegacyMapping" lm ON lm."legacyCollection" = 'estoques' AND lm."legacyDocId" = t."legacyDocId" ` +
        `ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, "updatedAt" = EXCLUDED."updatedAt";`
    );
    const mappingRows = estoques.map((e) => ({
      id: legacyMappingId('estoques', e.id),
      legacyDocId: e.id,
      fallbackStockLocationId: stockLocationId(e.id),
    }));
    statements.push(
      `INSERT INTO "LegacyMapping" (id, "entityType", "legacyCollection", "legacyDocId", "stockLocationId", "importBatchId", "importedAt") ` +
        `SELECT t.id, 'STOCK_LOCATION', 'estoques', t."legacyDocId", sl.id, ${sqlString(importBatchId)}, now() ` +
        `FROM json_to_recordset(${jsonLiteral(mappingRows)}) ` +
        `AS t(id text, "legacyDocId" text, "fallbackStockLocationId" text) ` +
        `JOIN "StockLocation" sl ON sl.id = COALESCE(` +
        `(SELECT "stockLocationId" FROM "LegacyMapping" WHERE "legacyCollection" = 'estoques' AND "legacyDocId" = t."legacyDocId"), ` +
        `t."fallbackStockLocationId") ` +
        `ON CONFLICT ("legacyCollection", "legacyDocId") DO UPDATE SET "stockLocationId" = EXCLUDED."stockLocationId";`
    );
  }

  // --- Product (só o balde `auto` — review/excluído nunca migram sozinhos) -
  // Product.code já é UNIQUE de verdade no schema — ON CONFLICT (code) por
  // si só já é idempotente e correto, sem precisar de LegacyMapping aqui.
  const productRows = classificacao.auto.map((item) => ({
    id: productId(item.codigo),
    code: item.codigo,
    description: item.descricao,
    active: item.ativo,
    unit: item.unidade ?? 'UNIDADE',
    type: item.tipo,
  }));
  for (const rows of chunk(productRows, MAX_ROWS_PER_STATEMENT)) {
    statements.push(
      `INSERT INTO "Product" (id, code, description, active, unit, type, "createdAt", "updatedAt") ` +
        `SELECT t.id, t.code, t.description, t.active, t.unit, t.type, now(), now() ` +
        `FROM json_to_recordset(${jsonLiteral(rows)}) ` +
        `AS t(id text, code text, description text, active boolean, unit text, type text) ` +
        `ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, active = EXCLUDED.active, "updatedAt" = EXCLUDED."updatedAt";`
    );
  }

  // --- LegacyMapping(PRODUCT) — resolve o productId pelo Product.code real,
  // nunca pelo id que calculei localmente (que só vale pra linha recém
  // inserida; um código já existente de antes tem outro id de verdade). ----
  const mappingRows = classificacao.auto.map((item) => ({
    id: legacyMappingId('itens', item.id),
    legacyDocId: item.id,
    legacyCode: item.codigo,
  }));
  for (const rows of chunk(mappingRows, MAX_ROWS_PER_STATEMENT)) {
    statements.push(
      `INSERT INTO "LegacyMapping" (id, "entityType", "legacyCollection", "legacyDocId", "legacyCode", "productId", "importBatchId", "importedAt") ` +
        `SELECT t.id, 'PRODUCT', 'itens', t."legacyDocId", t."legacyCode", p.id, ${sqlString(importBatchId)}, now() ` +
        `FROM json_to_recordset(${jsonLiteral(rows)}) AS t(id text, "legacyDocId" text, "legacyCode" text) ` +
        `JOIN "Product" p ON p.code = t."legacyCode" ` +
        `ON CONFLICT ("legacyCollection", "legacyDocId") DO UPDATE SET "productId" = EXCLUDED."productId";`
    );
  }

  // --- StockBalance (só linhas cujo item está no balde `auto`) -------------
  // Mesma regra: resolve productId por Product.code e stockLocationId pelo
  // LegacyMapping(estoques) — nunca por um id gerado localmente.
  const codigoPorItemId = new Map(classificacao.auto.map((item) => [item.id, item.codigo]));
  const balancoRows = [];
  for (const saldo of saldosOrigem) {
    const codigo = codigoPorItemId.get(saldo.itemId);
    if (!codigo) continue; // item em review/excluído: saldo fica de fora até a revisão terminar
    balancoRows.push({
      id: stockBalanceId(codigo, saldo.estoqueId),
      code: codigo,
      estoqueId: saldo.estoqueId,
      quantity: Number(saldo.qtd),
    });
  }
  for (const rows of chunk(balancoRows, MAX_ROWS_PER_STATEMENT)) {
    statements.push(
      `INSERT INTO "StockBalance" (id, "productId", "stockLocationId", quantity, "updatedAt") ` +
        `SELECT t.id, p.id, lm."stockLocationId", t.quantity, now() ` +
        `FROM json_to_recordset(${jsonLiteral(rows)}) AS t(id text, code text, "estoqueId" text, quantity numeric) ` +
        `JOIN "Product" p ON p.code = t.code ` +
        `JOIN "LegacyMapping" lm ON lm."legacyCollection" = 'estoques' AND lm."legacyDocId" = t."estoqueId" ` +
        `ON CONFLICT ("productId", "stockLocationId") DO UPDATE SET quantity = EXCLUDED.quantity, "updatedAt" = EXCLUDED."updatedAt";`
    );
  }

  return statements;
}
