// Bidirectional sync for the product<->component junction board ("רכיבים במוצר").
// Its identity is the PAIR of board-relations (which product + which component),
// not a name — the generic engine can't resolve relations. This module resolves
// each relation to a DB FK (and back) via the aligned parent tables, and guards
// against echo loops with loopGuard (hash of product-item + component-item + qty
// + sort, identical from both sides when in sync).

import { contentHash, getLink, isEcho, recordSynced } from './loopGuard.js';

const PC_BOARD = '5100631747';
const PROD_BOARD = '5100631748';
const COMP_BOARD = '5100631743';
const REL_PROD = 'board_relation_mm50cxjm'; // "מוצרים"
const REL_COMP = 'board_relation_mm50hagj'; // "רכיב"
const QTY = 'numeric_mm50ve5f';             // -> default_quantity
const SORT = 'numeric_mm50zfnx';            // -> sort_order
const ENTITY = 'deal_product';

function firstLinkedId(col) {
  if (col && Array.isArray(col.linked_item_ids) && col.linked_item_ids.length) return String(col.linked_item_ids[0]);
  return null;
}
function numOrNull(col) {
  if (!col || col.text == null || col.text === '') return null;
  const n = Number(String(col.text).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
const norm = (v) => (v == null ? '' : String(v).trim());

// Content hash of the junction — same from both sides when in sync.
function junctionHash({ productItem, componentItem, qty, sort }) {
  const fields = [{ monday_column_id: 'p' }, { monday_column_id: 'c' }, { monday_column_id: 'q' }, { monday_column_id: 's' }];
  const map = { p: norm(productItem), c: norm(componentItem), q: norm(qty), s: norm(sort) };
  return contentHash(fields, (f) => map[f.monday_column_id]);
}

async function one(supabase, table, filters, columns = 'id') {
  const r = await supabase.select(table, { columns, filters, limit: 1 });
  return r[0] || null;
}
const dbProductOf = (s, item) => one(s, 'products', [`monday_item_id=eq.${item}`, `monday_board_id=eq.${PROD_BOARD}`, 'deleted_at=is.null']);
const dbComponentOf = (s, item) => one(s, 'components', [`monday_item_id=eq.${item}`, `monday_board_id=eq.${COMP_BOARD}`, 'deleted_at=is.null']);
const prodItemOf = (s, id) => one(s, 'products', [`id=eq.${id}`, `monday_board_id=eq.${PROD_BOARD}`, 'deleted_at=is.null'], 'monday_item_id');
const compItemOf = (s, id) => one(s, 'components', [`id=eq.${id}`, `monday_board_id=eq.${COMP_BOARD}`, 'deleted_at=is.null'], 'monday_item_id');

// ── Monday → DB ───────────────────────────────────────────────────────
export async function syncProductComponentFromMonday({ supabase, monday, environment = 'test', itemId }) {
  const data = await monday.execute(
    `query($id:[ID!]){ items(ids:$id){ id column_values(ids:["${REL_PROD}","${REL_COMP}","${QTY}","${SORT}"]){ id text ... on BoardRelationValue{ linked_item_ids } } } }`,
    { id: [String(itemId)] },
  );
  const it = data && data.items && data.items[0];
  if (!it) return { status: 'skipped', reason: 'monday item not found' };
  const cols = {};
  for (const c of it.column_values) cols[c.id] = c;
  const pItem = firstLinkedId(cols[REL_PROD]);
  const cItem = firstLinkedId(cols[REL_COMP]);
  if (!pItem || !cItem) return { status: 'skipped', reason: 'relation empty (product/component)' };
  const qty = numOrNull(cols[QTY]);
  const sort = numOrNull(cols[SORT]);

  const hash = junctionHash({ productItem: pItem, componentItem: cItem, qty, sort });
  const link = await getLink(supabase, { environment, entityType: ENTITY, boardId: PC_BOARD, itemId });
  if (isEcho(link, 'monday', hash)) return { status: 'skipped', reason: 'echo' };

  const [prod, comp] = await Promise.all([dbProductOf(supabase, pItem), dbComponentOf(supabase, cItem)]);
  if (!prod) return { status: 'skipped', reason: `product not aligned (monday item ${pItem})` };
  if (!comp) return { status: 'skipped', reason: `component not aligned (monday item ${cItem})` };

  const patch = { default_quantity: qty, sort_order: sort, monday_board_id: String(PC_BOARD), monday_item_id: String(itemId) };
  let dbRow = await one(supabase, 'product_components', [`monday_item_id=eq.${itemId}`, 'deleted_at=is.null']);
  if (!dbRow) dbRow = (await supabase.select('product_components', { columns: 'id', filters: [`product_id=eq.${prod.id}`, `component_id=eq.${comp.id}`, 'deleted_at=is.null'], order: 'created_at', limit: 1 }))[0];

  let op, dbId;
  if (dbRow) { await supabase.updateById('product_components', dbRow.id, patch); op = 'update'; dbId = dbRow.id; }
  else {
    try { const c = await supabase.insert('product_components', [{ product_id: prod.id, component_id: comp.id, ...patch }]); op = 'create'; dbId = c && c[0] && c[0].id; }
    catch (e) { return { status: 'skipped', reason: 'create failed: ' + e.message }; }
  }
  await recordSynced(supabase, { environment, entityType: ENTITY, boardId: PC_BOARD, itemId, sourceRecordId: dbId, source: 'monday', mondayHash: hash, supabaseHash: hash });
  return { status: 'ok', op, side: 'db', entity: ENTITY, dbId, itemId };
}

// ── DB → Monday ───────────────────────────────────────────────────────
export async function syncProductComponentToMonday({ supabase, monday, environment = 'test', dbId }) {
  const rows = await supabase.select('product_components', { filters: [`id=eq.${dbId}`], limit: 1 });
  const row = rows[0];
  if (!row || row.deleted_at) return { status: 'skipped', reason: 'db row not found' };
  const [prodItem, compItem] = await Promise.all([prodItemOf(supabase, row.product_id), compItemOf(supabase, row.component_id)]);
  const productItem = prodItem && prodItem.monday_item_id ? String(prodItem.monday_item_id) : null;
  const componentItem = compItem && compItem.monday_item_id ? String(compItem.monday_item_id) : null;
  if (!productItem) return { status: 'skipped', reason: 'product not aligned to Monday' };
  if (!componentItem) return { status: 'skipped', reason: 'component not aligned to Monday' };
  const qty = row.default_quantity;
  const sort = row.sort_order;

  const hash = junctionHash({ productItem, componentItem, qty, sort });
  const linkedHere = row.monday_board_id && String(row.monday_board_id) === PC_BOARD && row.monday_item_id;
  const itemId = linkedHere ? String(row.monday_item_id) : null;
  if (itemId) {
    const link = await getLink(supabase, { environment, entityType: ENTITY, boardId: PC_BOARD, itemId });
    if (isEcho(link, 'supabase', hash)) return { status: 'skipped', reason: 'echo' };
  }

  let resultItemId = itemId, op;
  if (!itemId) {
    // create: set both relations + qty + sort
    const colVals = { [REL_PROD]: { item_ids: [Number(productItem)] }, [REL_COMP]: { item_ids: [Number(componentItem)] } };
    if (qty != null) colVals[QTY] = String(qty);
    if (sort != null) colVals[SORT] = String(sort);
    const created = await monday.createItem(PC_BOARD, null, 'רכיב במוצר', colVals);
    resultItemId = created && created.id ? String(created.id) : null;
    if (resultItemId) await supabase.updateById('product_components', row.id, { monday_board_id: String(PC_BOARD), monday_item_id: resultItemId }).catch(() => {});
    op = 'create';
  } else {
    // update: only the scalar fields change; relations are the identity (unchanged)
    const colVals = {};
    if (qty != null) colVals[QTY] = String(qty);
    if (sort != null) colVals[SORT] = String(sort);
    if (Object.keys(colVals).length) await monday.changeColumnValues(PC_BOARD, itemId, colVals);
    op = 'update';
  }
  if (!resultItemId) return { status: 'failed', reason: 'no monday item id' };
  await recordSynced(supabase, { environment, entityType: ENTITY, boardId: PC_BOARD, itemId: resultItemId, sourceRecordId: row.id, source: 'supabase', mondayHash: hash, supabaseHash: hash });
  return { status: 'ok', op, side: 'monday', entity: ENTITY, dbId: row.id, itemId: resultItemId };
}
