// Bidirectional sync for the product<->component junction board ("רכיבים במוצר").
// Its identity is the PAIR of board-relations (which product + which component),
// not a name — the generic engine can't resolve relations. This module resolves
// each relation to a DB FK (and back) via the aligned parent tables, and guards
// against echo loops with loopGuard.
//
// FULLY ENV-AWARE — no hardcoded ids. All configuration is read from the
// control-plane per environment:
//   • the three board ids come from the product / component_operation /
//     deal_product targets (monday_export_targets, keyed by environment);
//   • the qty/sort Monday columns come from the junction target's field mappings;
//   • the two relation columns are discovered from the junction board's metadata
//     (matched by which board each relation points to).

import { getTargets, getFieldMappings } from '../controlPlane.js';
import { contentHash, getLink, isEcho, recordSynced } from './loopGuard.js';

const ENTITY = 'deal_product';        // the junction
const PRODUCT_ENTITY = 'product';
const COMPONENT_ENTITY = 'component_operation';
const CONFIG_TTL_MS = 5 * 60 * 1000;
const _cfgCache = new Map(); // environment -> { at, cfg }

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

// Resolve all ids/columns from the control-plane + board metadata (cached per env).
async function resolveConfig(supabase, monday, environment) {
  const cached = _cfgCache.get(environment);
  if (cached && (Date.now() - cached.at) < CONFIG_TTL_MS) return cached.cfg;

  const targets = await getTargets(supabase, environment);
  const byEntity = {};
  for (const t of targets) byEntity[t.entity_type] = t;
  const pcT = byEntity[ENTITY];
  const prodT = byEntity[PRODUCT_ENTITY];
  const compT = byEntity[COMPONENT_ENTITY];
  if (!pcT || !prodT || !compT) {
    throw new Error(`product_components config: missing target(s) for env "${environment}" (need ${ENTITY}, ${PRODUCT_ENTITY}, ${COMPONENT_ENTITY})`);
  }
  const productsTable = 'products';
  const componentsTable = 'components';
  const cfg = {
    targetId: pcT.id,
    pcBoard: String(pcT.monday_board_id),
    prodBoard: String(prodT.monday_board_id),
    compBoard: String(compT.monday_board_id),
    productsTable, componentsTable,
    relProd: null, relComp: null, qtyCol: null, sortCol: null,
  };

  // qty/sort columns from the junction target's field mappings
  const mappings = await getFieldMappings(supabase, pcT.id);
  cfg.qtyCol = (mappings.find((m) => m.source_field === 'default_quantity') || {}).monday_column_id || null;
  cfg.sortCol = (mappings.find((m) => m.source_field === 'sort_order') || {}).monday_column_id || null;

  // relation columns discovered from the junction board metadata, matched by the
  // board each relation points to.
  const meta = await monday.getBoardMeta(cfg.pcBoard);
  for (const c of (meta && meta.columns) || []) {
    if (c.type !== 'board_relation') continue;
    let boardIds = [];
    try { boardIds = (JSON.parse(c.settings_str || '{}').boardIds || []).map(String); } catch { /* ignore */ }
    if (boardIds.includes(cfg.prodBoard)) cfg.relProd = c.id;
    else if (boardIds.includes(cfg.compBoard)) cfg.relComp = c.id;
  }
  if (!cfg.relProd || !cfg.relComp || !cfg.qtyCol || !cfg.sortCol) {
    throw new Error(`product_components config incomplete for env "${environment}": ${JSON.stringify({ relProd: cfg.relProd, relComp: cfg.relComp, qtyCol: cfg.qtyCol, sortCol: cfg.sortCol })}`);
  }

  _cfgCache.set(environment, { at: Date.now(), cfg });
  return cfg;
}

async function one(supabase, table, filters, columns = 'id') {
  const r = await supabase.select(table, { columns, filters, limit: 1 });
  return r[0] || null;
}

// ── Monday → DB ───────────────────────────────────────────────────────
export async function syncProductComponentFromMonday({ supabase, monday, environment = 'test', itemId }) {
  const cfg = await resolveConfig(supabase, monday, environment);
  const data = await monday.execute(
    `query($id:[ID!]){ items(ids:$id){ id column_values(ids:["${cfg.relProd}","${cfg.relComp}","${cfg.qtyCol}","${cfg.sortCol}"]){ id text ... on BoardRelationValue{ linked_item_ids } } } }`,
    { id: [String(itemId)] },
  );
  const it = data && data.items && data.items[0];
  if (!it) return { status: 'skipped', reason: 'monday item not found' };
  const cols = {};
  for (const c of it.column_values) cols[c.id] = c;
  const pItem = firstLinkedId(cols[cfg.relProd]);
  const cItem = firstLinkedId(cols[cfg.relComp]);
  if (!pItem || !cItem) return { status: 'skipped', reason: 'relation empty (product/component)' };
  const qty = numOrNull(cols[cfg.qtyCol]);
  const sort = numOrNull(cols[cfg.sortCol]);

  const hash = junctionHash({ productItem: pItem, componentItem: cItem, qty, sort });
  const link = await getLink(supabase, { environment, entityType: ENTITY, boardId: cfg.pcBoard, itemId });
  if (isEcho(link, 'monday', hash)) return { status: 'skipped', reason: 'echo' };

  const [prod, comp] = await Promise.all([
    one(supabase, cfg.productsTable, [`monday_item_id=eq.${pItem}`, `monday_board_id=eq.${cfg.prodBoard}`, 'deleted_at=is.null']),
    one(supabase, cfg.componentsTable, [`monday_item_id=eq.${cItem}`, `monday_board_id=eq.${cfg.compBoard}`, 'deleted_at=is.null']),
  ]);
  if (!prod) return { status: 'skipped', reason: `product not aligned (monday item ${pItem})` };
  if (!comp) return { status: 'skipped', reason: `component not aligned (monday item ${cItem})` };

  const patch = { default_quantity: qty, sort_order: sort, monday_board_id: cfg.pcBoard, monday_item_id: String(itemId) };
  let dbRow = await one(supabase, 'product_components', [`monday_item_id=eq.${itemId}`, 'deleted_at=is.null']);
  if (!dbRow) dbRow = (await supabase.select('product_components', { columns: 'id', filters: [`product_id=eq.${prod.id}`, `component_id=eq.${comp.id}`, 'deleted_at=is.null'], order: 'created_at', limit: 1 }))[0];

  let op, dbId;
  if (dbRow) { await supabase.updateById('product_components', dbRow.id, patch); op = 'update'; dbId = dbRow.id; }
  else {
    try { const c = await supabase.insert('product_components', [{ product_id: prod.id, component_id: comp.id, ...patch }]); op = 'create'; dbId = c && c[0] && c[0].id; }
    catch (e) { return { status: 'skipped', reason: 'create failed: ' + e.message }; }
  }
  await recordSynced(supabase, { environment, entityType: ENTITY, boardId: cfg.pcBoard, itemId, targetId: cfg.targetId, sourceRecordId: dbId, source: 'monday', mondayHash: hash, supabaseHash: hash });
  return { status: 'ok', op, side: 'db', entity: ENTITY, dbId, itemId };
}

// ── DB → Monday ───────────────────────────────────────────────────────
export async function syncProductComponentToMonday({ supabase, monday, environment = 'test', dbId }) {
  const cfg = await resolveConfig(supabase, monday, environment);
  const rows = await supabase.select('product_components', { filters: [`id=eq.${dbId}`], limit: 1 });
  const row = rows[0];
  if (!row || row.deleted_at) return { status: 'skipped', reason: 'db row not found' };
  const [prod, comp] = await Promise.all([
    one(supabase, cfg.productsTable, [`id=eq.${row.product_id}`, `monday_board_id=eq.${cfg.prodBoard}`, 'deleted_at=is.null'], 'monday_item_id'),
    one(supabase, cfg.componentsTable, [`id=eq.${row.component_id}`, `monday_board_id=eq.${cfg.compBoard}`, 'deleted_at=is.null'], 'monday_item_id'),
  ]);
  const productItem = prod && prod.monday_item_id ? String(prod.monday_item_id) : null;
  const componentItem = comp && comp.monday_item_id ? String(comp.monday_item_id) : null;
  if (!productItem) return { status: 'skipped', reason: 'product not aligned to Monday' };
  if (!componentItem) return { status: 'skipped', reason: 'component not aligned to Monday' };
  const qty = row.default_quantity;
  const sort = row.sort_order;

  const hash = junctionHash({ productItem, componentItem, qty, sort });
  const linkedHere = row.monday_board_id && String(row.monday_board_id) === cfg.pcBoard && row.monday_item_id;
  const itemId = linkedHere ? String(row.monday_item_id) : null;
  if (itemId) {
    const link = await getLink(supabase, { environment, entityType: ENTITY, boardId: cfg.pcBoard, itemId });
    if (isEcho(link, 'supabase', hash)) return { status: 'skipped', reason: 'echo' };
  }

  let resultItemId = itemId, op;
  if (!itemId) {
    const colVals = { [cfg.relProd]: { item_ids: [Number(productItem)] }, [cfg.relComp]: { item_ids: [Number(componentItem)] } };
    if (qty != null) colVals[cfg.qtyCol] = String(qty);
    if (sort != null) colVals[cfg.sortCol] = String(sort);
    const created = await monday.createItem(cfg.pcBoard, null, 'רכיב במוצר', colVals);
    resultItemId = created && created.id ? String(created.id) : null;
    if (resultItemId) await supabase.updateById('product_components', row.id, { monday_board_id: cfg.pcBoard, monday_item_id: resultItemId }).catch(() => {});
    op = 'create';
  } else {
    const colVals = {};
    if (qty != null) colVals[cfg.qtyCol] = String(qty);
    if (sort != null) colVals[cfg.sortCol] = String(sort);
    if (Object.keys(colVals).length) await monday.changeColumnValues(cfg.pcBoard, itemId, colVals);
    op = 'update';
  }
  if (!resultItemId) return { status: 'failed', reason: 'no monday item id' };
  await recordSynced(supabase, { environment, entityType: ENTITY, boardId: cfg.pcBoard, itemId: resultItemId, targetId: cfg.targetId, sourceRecordId: row.id, source: 'supabase', mondayHash: hash, supabaseHash: hash });
  return { status: 'ok', op, side: 'monday', entity: ENTITY, dbId: row.id, itemId: resultItemId };
}
