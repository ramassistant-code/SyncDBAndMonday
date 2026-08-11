// DB→Monday push enrichment for things the generic scalar-mapping engine can't
// express, driven by the FK columns already on each table:
//
//   • composed item titles           (req 6)  — "customer | created_at [| credit x qty]"
//   • board_relation (linked) columns (req 5,8) — child item → parent item, by the
//                                                 parent's monday_item_id
//   • derived status/text columns     (req 7)  — a FK resolved to a joined display
//                                                 value (e.g. salesperson full name)
//
// These only ever run on the DB→Monday PUSH path (real-time cascade + manual
// db_to_monday apply). The Monday→DB pull path is unaffected.
//
// Monday column ids below mirror the live boards. board_relation ids are IDENTICAL
// dev↔prod (dev was cloned from prod). Columns added recently (payment→salesperson
// link, task→deal, payment "salesperson" status, discount reasons) MUST be verified
// in production before enabling there — see SYNC_FIXES.md.

import { ENTITY_TABLE } from './entities.js';

// Pinned to Israel time so composed titles read the same regardless of host
// timezone (the engine runs on Railway/UTC).
const DT_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

// "YYYY-MM-DD HH:MM" from a timestamptz/date value (created_at carries a time).
export function fmtDateTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = Object.fromEntries(DT_FMT.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

const joinTitle = (parts) => parts.filter((p) => p != null && String(p).trim() !== '').join(' | ');

// Per-entity push config.
//   title.build(row, ctx)  → the Monday item name (ctx.customer = resolved customer name)
//   relations[]            → { fk, parentEntity, column }  FK col → parent's item in a board_relation column
//   derived[]              → { fk, table, field, column, type }  FK col → joined value in a status/text column
export const PUSH_CONFIG = {
  deal: {
    title: { build: (r, ctx) => joinTitle([ctx.customer, fmtDateTime(r.created_at)]) },
    relations: [
      { fk: 'lead_id', parentEntity: 'lead', column: 'board_relation_mm3twpfx' },   // deal → lead ("לידים")
    ],
    derived: [
      // "איש מכירות" status = the deal's salesperson full name (label created if
      // missing — same pattern as payment). Only fires when deals.salesperson_id
      // is set; it is NOT populated on most deals today (upstream/app gap).
      { fk: 'salesperson_id', table: 'app_users', field: 'full_name', column: 'color_mktwdp8c', type: 'status' },
    ],
  },
  customer: {
    // "ליד מקושר": mirror customers.lead_id → the originating lead's Monday item.
    // Backfilled on update, so an already-created customer gets linked on its next
    // push — provided the lead itself is already in Monday (has a monday_item_id).
    relations: [
      { fk: 'lead_id', parentEntity: 'lead', column: 'board_relation_mkzm5f4f' },   // customer → lead
    ],
  },
  lead: {
    // "איש מכירות": mirror leads.salesperson_id → the salesperson's Monday item on
    // the salespeople board (board_relation). No composed title → the lead's name
    // keeps syncing normally. Paired with INBOUND_RELATIONS.lead for Monday→DB.
    relations: [
      { fk: 'salesperson_id', parentEntity: 'salesperson', column: 'board_relation_mky9akx2' }, // lead → salesperson
    ],
  },
  payment: {
    title: { build: (r, ctx) => joinTitle([ctx.customer, fmtDateTime(r.created_at)]) },
    relations: [
      { fk: 'deal_id', parentEntity: 'deal', column: 'board_relation_mktnjr7z' },          // 5b payment → deal
      { fk: 'salesperson_id', parentEntity: 'salesperson', column: 'board_relation_mm5js0ns' }, // 8  payment → salesperson (link by id)
    ],
    derived: [
      // 7  "איש מכירות" status = the salesperson's full name (label created if missing).
      { fk: 'salesperson_id', table: 'app_users', field: 'full_name', column: 'color_mm03ctf0', type: 'status' },
    ],
  },
  credit: {
    // 6a  "customer | created_at | credit_name x quantity"
    title: { build: (r, ctx) => joinTitle([ctx.customer, fmtDateTime(r.created_at), creditNamePart(r)]) },
    relations: [
      { fk: 'deal_id', parentEntity: 'deal', column: 'board_relation_mkv7apeh' },          // 5a credit → deal
    ],
    derived: [
      // internal_note from the ORIGINATING quote component → "הערה מאיש מכירות בזמן הצעת מחיר".
      // The engine reads quote_components directly via credits.source_quote_component_id
      // (the credit table has no note column of its own). DB→Monday only; overrides the
      // legacy salesperson_note field-mapping for this column (enrich runs after mappings).
      { fk: 'source_quote_component_id', table: 'quote_components', field: 'internal_note', column: 'long_text_mkvcfdhq', type: 'long_text' },
    ],
  },
  coordination_task: {
    relations: [
      { fk: 'deal_id', parentEntity: 'deal', column: 'board_relation_mm5jv7cn' },          // 5c task → deal
    ],
  },
  salesperson: {
    // The board "סטטוס" column is active/inactive — map it from app_users.is_active
    // (NOT the user_role enum). Boolean → Hebrew label.
    computed: [
      { column: 'status', type: 'status', build: (r) => (r.is_active === false ? 'לא פעיל' : 'פעיל') },
    ],
  },
};

function creditNamePart(r) {
  const name = r.credit_name || r.parent_product_name;
  if (name && r.quantity != null && String(r.quantity).trim() !== '') return `${name} x ${r.quantity}`;
  return name || '';
}

// Monday→DB counterpart to PUSH_CONFIG.relations: resolve a child item's
// board_relation columns to the DB FK column, by matching the linked Monday item
// to a parent DB row via its monday_item_id. Same board_relation column ids as
// the outbound relations, read in the reverse direction. The generic scalar path
// cannot do this — board_relation reports text/value=null; only the typed
// `linked_item_ids` (via getItem) carries the link.
export const INBOUND_RELATIONS = {
  payment: [
    { fk: 'deal_id', parentEntity: 'deal', column: 'board_relation_mktnjr7z' },          // עסקה מקושרת
    { fk: 'salesperson_id', parentEntity: 'salesperson', column: 'board_relation_mm5js0ns' }, // לינק איש מכירות
  ],
  lead: [
    { fk: 'salesperson_id', parentEntity: 'salesperson', column: 'board_relation_mky9akx2' }, // איש מכירות
  ],
};

export function hasInboundRelations(entityType) {
  return Boolean(INBOUND_RELATIONS[entityType]);
}

// Resolve inbound board_relation columns of `item` to DB FK values for `entityType`.
// Returns { <fk>: <parentDbId> } for each relation that is NON-EMPTY in Monday AND
// resolves to a parent row on THIS environment's board (via boardByEntity guard).
// An empty relation is skipped (never nulls the FK — clearing a link in Monday
// does not wipe the DB FK, mirroring the outbound "never clear" guard). The caller
// diffs against the current row and only writes changed FKs (idempotent).
export async function resolveInboundRelations({ supabase, entityType, item, boardByEntity = null }) {
  const rels = INBOUND_RELATIONS[entityType];
  const out = {};
  if (!rels || !item) return out;
  for (const rel of rels) {
    const linkedIds = currentRelationIds(item, rel.column);
    if (!linkedIds.length) continue;                       // relation empty → leave FK untouched
    const table = ENTITY_TABLE[rel.parentEntity];
    if (!table) continue;
    const parentItemId = String(linkedIds[0]);
    const filters = [`monday_item_id=eq.${parentItemId}`, 'deleted_at=is.null'];
    // Board guard: only match a parent linked to THIS env's board for its entity,
    // else the item id belongs to another environment (drift) and is invalid here.
    if (boardByEntity && boardByEntity[rel.parentEntity]) {
      filters.push(`monday_board_id=eq.${boardByEntity[rel.parentEntity]}`);
    }
    const rows = await supabase.select(table, { columns: 'id', filters, limit: 1 }).catch(() => []);
    if (rows[0]) out[rel.fk] = rows[0].id;
  }
  return out;
}

export function hasPushConfig(entityType) {
  return Boolean(PUSH_CONFIG[entityType]);
}

// True only for entities whose Monday title is a COMPOSED name (create-only,
// DB-owned) — used to skip overwriting the title with the mapped name field on
// update. Entities with only relations/derived/computed (salesperson,
// coordination_task) keep syncing their name normally.
export function hasComposedTitle(entityType) {
  return Boolean(PUSH_CONFIG[entityType]?.title);
}

// Small per-call cache so a batch push doesn't re-query the same customer/deal/user.
export function makeEnrichCache() {
  return new Map(); // key: `${table}:${id}` -> row|null
}

async function fetchRow(supabase, cache, table, id, columns) {
  if (!id) return null;
  const key = `${table}:${id}`;
  if (cache && cache.has(key)) return cache.get(key);
  const rows = await supabase.select(table, { columns, filters: [`id=eq.${id}`], limit: 1 }).catch(() => []);
  const row = rows[0] || null;
  if (cache) cache.set(key, row);
  return row;
}

// The item ids currently linked in a Monday board_relation column. board_relation
// reports text/value as null, so we read the typed `linkedIds` (from getItem);
// fall back to parsing value JSON for any other shape.
function currentRelationIds(item, colId) {
  const c = item && item.columns ? item.columns[colId] : null;
  if (!c) return [];
  if (Array.isArray(c.linkedIds)) return c.linkedIds.map(Number).filter(Boolean);
  if (!c.value) return [];
  try {
    const v = JSON.parse(c.value);
    return (v.linkedPulseIds || v.linkedItems || []).map((x) => Number(x.linkedPulseId ?? x.linkedItemId)).filter(Boolean);
  } catch { return []; }
}
const currentText = (item, colId) => {
  const c = item && item.columns ? item.columns[colId] : null;
  return c ? c.text : null;
};

// Resolve the composed title + extra column values (relations + derived) for one
// DB row. `mode` = 'create' | 'update'. Titles are written on create only. On
// update, `item` (the current Monday item) lets us skip links/values already set
// so pushes don't churn — while still BACKFILLING links that are missing.
//
// `boardByEntity` maps entity_type → this environment's Monday board id (from the
// control-plane targets). It guards board_relation writes so we never link a
// child to a parent item that lives on a DIFFERENT board (cross-env drift): a
// dev payment must not get a prod salesperson's item id. When omitted, links are
// written whenever the parent has any monday_item_id.
export async function enrichPush({ supabase, target, dbRow, mode = 'create', cache, item = null, boardByEntity = null }) {
  const cfg = PUSH_CONFIG[target.entity_type];
  const out = { title: null, colVals: {} };
  if (!cfg) return out;

  // customer name for the composed title
  if (cfg.title && mode === 'create') {
    let customer = null;
    if (dbRow.customer_id) {
      const c = await fetchRow(supabase, cache, 'customers', dbRow.customer_id, 'id,name');
      customer = c?.name || null;
    }
    out.title = cfg.title.build(dbRow, { customer });
  }

  // board_relation links → { <col>: { item_ids: [parentItemId] } }
  for (const rel of (cfg.relations || [])) {
    const fkVal = dbRow[rel.fk];
    if (!fkVal) continue;
    const table = ENTITY_TABLE[rel.parentEntity];
    if (!table) continue;
    const parent = await fetchRow(supabase, cache, table, fkVal, 'id,monday_item_id,monday_board_id');
    if (!parent?.monday_item_id) continue;
    // Board guard: the parent must be linked to THIS environment's board for its
    // entity, else its item id belongs to another env (drift) and would be invalid.
    if (boardByEntity && boardByEntity[rel.parentEntity] &&
        String(parent.monday_board_id) !== String(boardByEntity[rel.parentEntity])) continue;
    const parentItemId = Number(parent.monday_item_id);
    if (mode === 'update' && currentRelationIds(item, rel.column).includes(parentItemId)) continue; // already linked
    out.colVals[rel.column] = { item_ids: [parentItemId] };
  }

  // derived joined values → status label / text
  for (const d of (cfg.derived || [])) {
    const fkVal = dbRow[d.fk];
    if (!fkVal) continue;
    const row = await fetchRow(supabase, cache, d.table, fkVal, `id,${d.field}`);
    const val = row?.[d.field];
    if (val == null || String(val).trim() === '') continue;
    if (mode === 'update' && String(currentText(item, d.column) || '').trim() === String(val).trim()) continue; // unchanged
    out.colVals[d.column] = d.type === 'status' ? { label: String(val) } : String(val);
  }

  // computed columns → a value derived from this row itself (no join)
  for (const c of (cfg.computed || [])) {
    const val = c.build(dbRow);
    if (val == null || String(val).trim() === '') continue;
    if (mode === 'update' && String(currentText(item, c.column) || '').trim() === String(val).trim()) continue; // unchanged
    out.colVals[c.column] = c.type === 'status' ? { label: String(val) } : String(val);
  }

  return out;
}
