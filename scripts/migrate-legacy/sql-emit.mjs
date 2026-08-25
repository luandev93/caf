import { createHash, randomUUID } from 'node:crypto';

// Este sandbox não alcança Postgres via TCP direto (só HTTPS via proxy), então
// write-prisma.mjs (PrismaClient) não roda aqui. Este módulo gera as mesmas
// escritas como SQL puro, para serem aplicadas via mcp__Neon__run_sql_transaction
// (mesmo mecanismo já usado para aplicar o schema). Fora de uma sessão Claude
// (CI, máquina local com Postgres alcançável), write-prisma.mjs continua válido.

const DEFAULT_INSTITUTION_NAME =
  'HMMV (padrão provisório — redefinir por unidade após auditoria completa)';

/** UUID determinístico a partir de uma chave legada — permite reemitir o SQL
 * várias vezes (idempotente via ON CONFLICT) sem round-trip ao banco para
 * descobrir ids já existentes. */
function deterministicUuid(seed) {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sqlValue(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function insertOnConflict(table, columns, values, conflictColumns, updateColumns) {
  const cols = columns.map((c) => `"${c}"`).join(', ');
  const vals = values.map(sqlValue).join(', ');
  const conflict = conflictColumns.map((c) => `"${c}"`).join(', ');
  const updates = updateColumns.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
  return `INSERT INTO "${table}" (${cols}) VALUES (${vals}) ON CONFLICT (${conflict}) DO UPDATE SET ${updates};`;
}

/**
 * Monta os statements SQL equivalentes ao que write-prisma.mjs faria, para o
 * mesmo escopo (Institution padrão, StockLocation por estoque, Product por
 * item `auto` do saneamento, LegacyMapping, StockBalance por saldo
 * reconciliado). Retorna { statements, ids } — `ids` expõe os ids
 * determinísticos gerados, úteis para conferir via SELECT depois.
 */
export function emitMigrationSql({ auto, estoques, saldos, importBatchId = `import-${new Date().toISOString()}` }) {
  const statements = [];
  const now = new Date().toISOString();

  const institutionId = deterministicUuid(`institution:default`);
  statements.push(
    insertOnConflict(
      'Institution',
      ['id', 'name', 'type', 'createdAt', 'updatedAt'],
      [institutionId, DEFAULT_INSTITUTION_NAME, 'HM', now, now],
      ['id'],
      ['name', 'type', 'updatedAt']
    )
  );

  const estoqueIdToStockLocationId = new Map();
  for (const estoque of estoques) {
    const stockLocationId = deterministicUuid(`stockLocation:estoques:${estoque.id}`);
    estoqueIdToStockLocationId.set(estoque.id, stockLocationId);
    statements.push(
      insertOnConflict(
        'StockLocation',
        ['id', 'institutionId', 'name', 'active', 'createdAt', 'updatedAt'],
        [stockLocationId, institutionId, estoque.data.nome ?? estoque.id, estoque.data.ativo !== false, now, now],
        ['id'],
        ['name', 'active', 'updatedAt']
      )
    );
    statements.push(
      insertOnConflict(
        'LegacyMapping',
        ['id', 'entityType', 'legacyCollection', 'legacyDocId', 'stockLocationId', 'importBatchId', 'importedAt'],
        [randomUUID(), 'STOCK_LOCATION', 'estoques', estoque.id, stockLocationId, importBatchId, now],
        ['legacyCollection', 'legacyDocId'],
        ['stockLocationId', 'importBatchId']
      )
    );
  }

  const itemIdToProductId = new Map();
  for (const entry of auto) {
    const productId = deterministicUuid(`product:itens:${entry.itemId}`);
    itemIdToProductId.set(entry.itemId, productId);
    const p = entry.product;
    statements.push(
      insertOnConflict(
        'Product',
        [
          'id', 'code', 'description', 'activeIngredient', 'concentration', 'pharmaceuticalForm', 'unit', 'type',
          'atcGroup', 'atcGroupName', 'pharmacologicalGroup', 'controlled', 'thermolabile', 'highAlert', 'minStock',
          'controlsBatch', 'active', 'createdAt', 'updatedAt',
        ],
        [
          productId, p.code, p.description, p.activeIngredient, p.concentration, p.pharmaceuticalForm, p.unit, p.type,
          p.atcGroup, p.atcGroupName, p.pharmacologicalGroup, p.controlled, p.thermolabile, p.highAlert, p.minStock,
          p.controlsBatch, p.active, now, now,
        ],
        ['code'],
        [
          'description', 'activeIngredient', 'concentration', 'pharmaceuticalForm', 'unit', 'type', 'atcGroup',
          'atcGroupName', 'pharmacologicalGroup', 'controlled', 'thermolabile', 'highAlert', 'minStock',
          'controlsBatch', 'active', 'updatedAt',
        ]
      )
    );
    statements.push(
      insertOnConflict(
        'LegacyMapping',
        ['id', 'entityType', 'legacyCollection', 'legacyDocId', 'legacyCode', 'productId', 'importBatchId', 'importedAt'],
        [randomUUID(), 'PRODUCT', 'itens', entry.itemId, entry.codigo, productId, importBatchId, now],
        ['legacyCollection', 'legacyDocId'],
        ['legacyCode', 'productId', 'importBatchId']
      )
    );
  }

  const semCorrespondencia = [];
  for (const saldo of saldos) {
    const productId = itemIdToProductId.get(saldo.data.itemId);
    const stockLocationId = estoqueIdToStockLocationId.get(saldo.data.estoqueId);
    if (!productId || !stockLocationId) {
      semCorrespondencia.push({
        saldoId: saldo.id,
        itemId: saldo.data.itemId,
        estoqueId: saldo.data.estoqueId,
        motivo: !productId ? 'produto-nao-migrado' : 'estoque-nao-migrado',
      });
      continue;
    }
    statements.push(
      insertOnConflict(
        'StockBalance',
        ['id', 'productId', 'stockLocationId', 'quantity', 'updatedAt'],
        [randomUUID(), productId, stockLocationId, Number(saldo.data.qtd) || 0, now],
        ['productId', 'stockLocationId'],
        ['quantity', 'updatedAt']
      )
    );
  }

  return {
    statements,
    ids: { institutionId, estoqueIdToStockLocationId, itemIdToProductId },
    semCorrespondencia,
  };
}
