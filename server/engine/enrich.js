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
      // That FK is never written by the app, so `fallback` resolves the same row the
      // long way — see quoteComponentNote().
      { fk: 'source_quote_component_id', table: 'quote_components', field: 'internal_note',
        column: 'long_text_mkvcfdhq', type: 'long_text', fallback: quoteComponentNote },
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

// Resolve a credit's originating quote component WITHOUT credits.source_quote_component_id.
// The app never populates that FK (0 of 1119 prod credits have it) — what it does write
// is the catalog pair the credit was generated from (source_product_id +
// source_component_id) plus deals.quote_id. Walk that path instead:
//   credit → deals.quote_id → quote_products (same source_product_id)
//          → quote_components (same source_component_id) → internal_note
// Scoping to the product line matters: the same component can appear under two
// different products in one quote, each with its own note.
async function quoteComponentNote({ supabase, dbRow, cache }) {
  if (!dbRow.source_component_id || !dbRow.deal_id) return null;
  const deal = await fetchRow(supabase, cache, 'deals', dbRow.deal_id, 'id,quote_id');
  if (!deal?.quote_id) return null;

  const products = await supabase.select('quote_products', {
    columns: 'id,source_product_id',
    filters: [`quote_id=eq.${deal.quote_id}`, 'deleted_at=is.null'],
  }).catch(() => []);
  if (!products.length) return null;
  // Prefer the line for the same catalog product; if the credit doesn't say which
  // product it came from, search every line of the quote.
  const scoped = dbRow.source_product_id
    ? products.filter((p) => String(p.source_product_id) === String(dbRow.source_product_id))
    : [];
  const ids = (scoped.length ? scoped : products).map((p) => `"${p.id}"`).join(',');

  const comps = await supabase.select('quote_components', {
    columns: 'id,internal_note,quantity',
    filters: [
      `quote_product_id=in.(${ids})`,
      `source_component_id=eq.${dbRow.source_component_id}`,
      'deleted_at=is.null',
    ],
  }).catch(() => []);

  const withNote = comps.filter((r) => r.internal_note && String(r.internal_note).trim() !== '');
  if (!withNote.length) return null;
  // Same component twice on one line is rare — prefer the row whose quantity matches.
  const exact = withNote.find((r) => Number(r.quantity) === Number(dbRow.quantity));
  return (exact || withNote[0]).internal_note;
}

function creditNamePart(r) {
  const name = r.credit_name || r.parent_product_name;
  if (name && r.quantity != null && String(r.quantity).trim() !== '') return `${name} x ${r.quantity}`;
  return name || '';
}

// ── Monday title → credit name (the inverse of the two composed formats) ──
// A credit's Monday title is a LABEL, not its name: ours reads
// "customer | 2026-08-24 18:46 | עריכת שורט סטנדרט x 4", and the ones the app
// writes read "customer | עריכת שורט סטנדרט - 4 | 2026-08-24". Feeding that
// label straight back into credits.credit_name (the `name` mapping is
// bidirectional) overwrote the real component name on 1,062 of 1,169 live
// production rows. Recover the name the label embeds instead.
//
// Anything that is NOT one of those two shapes is a name a human typed on the
// board ("ספיר גנון 15 רילס סטנדרט") and is returned untouched — the engine
// must not guess at free text.
const TITLE_COMPOSED_OURS = /^.*? \| \d{4}-\d{2}-\d{2} \d{2}:\d{2} \| (.+) x [\d.]+$/;
const TITLE_COMPOSED_APP = /^.*? \| (.+) - [\d.]+ \| \d{4}-\d{2}-\d{2}$/;

export function creditNameFromTitle(title) {
  if (title == null) return title;
  const t = String(title).trim();
  const m = TITLE_COMPOSED_OURS.exec(t) || TITLE_COMPOSED_APP.exec(t);
  const name = m && m[1].trim();
  return name || title;
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
  credit: [
    // Mirror of PUSH_CONFIG.credit.relations — same board_relation column, read
    // inbound. Without it a credit created in Monday (or created there by our own
    // push and reflected back) lands with deal_id NULL and belongs to no deal:
    // 165 live production rows were in that state.
    { fk: 'deal_id', parentEntity: 'deal', column: 'board_relation_mkv7apeh' },              // עסקה מקושרת
  ],
};

export function hasInboundRelations(entityType) {
  return Boolean(INBOUND_RELATIONS[entityType]);
}

// Fields a child INHERITS from its parent when the child's own value is empty.
// A payment created in Monday carries only the "עסקה מקושרת" link: the board has
// no customer column at all, and its salesperson column is optional. Resolving
// deal_id therefore left customer_id/salesperson_id NULL on every Monday-created
// payment (1698 live rows before migration 015), which the app needs. The deal
// already holds both, so take them from there.
export const INBOUND_INHERIT = {
  payment: { parentFk: 'deal_id', parentTable: 'deals', fields: ['customer_id', 'salesperson_id'] },
  // The credits board has no customer column either — same gap, same fix. Only
  // fills an empty customer_id, and only from a deal that has one.
  credit: { parentFk: 'deal_id', parentTable: 'deals', fields: ['customer_id'] },
};

// Values to inherit from the parent row for ONE inbound child.
// `resolved` is the FK map just resolved from the board_relation columns; the
// parent is looked up there first (create: the row does not exist yet) and then
// on the existing row. Only NULL/empty child fields are filled — a payment that
// carries its own customer keeps it — and only from a parent that actually has a
// value, so this never writes NULL over anything.
export async function resolveInboundInherited({ supabase, entityType, dbRow, resolved = {}, cache }) {
  const cfg = INBOUND_INHERIT[entityType];
  const out = {};
  if (!cfg) return out;
  const parentId = resolved[cfg.parentFk] || (dbRow ? dbRow[cfg.parentFk] : null);
  if (!parentId) return out;
  const parent = await fetchRow(supabase, cache, cfg.parentTable, parentId, ['id', ...cfg.fields].join(','));
  if (!parent) return out;
  for (const f of cfg.fields) {
    if (dbRow && dbRow[f]) continue;   // child already has its own value
    if (parent[f]) out[f] = parent[f];
  }
  return out;
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
// `out.fingerprint` carries every enriched value this row RESOLVES TO, including
// the ones `colVals` drops because Monday already holds them. colVals is a delta
// (what to write now); the fingerprint is state (what the DB says this item's
// enriched columns should be). Only the latter is stable enough to hash for the
// echo guard — see loopGuard.valuesHash. The composed title is deliberately left
// out: it is written on create only, so a change to it must not force pushes.
export async function enrichPush({ supabase, target, dbRow, mode = 'create', cache, item = null, boardByEntity = null }) {
  const cfg = PUSH_CONFIG[target.entity_type];
  const out = { title: null, colVals: {}, fingerprint: {} };
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
    out.fingerprint[rel.column] = { item_ids: [parentItemId] };
    if (mode === 'update' && currentRelationIds(item, rel.column).includes(parentItemId)) continue; // already linked
    out.colVals[rel.column] = { item_ids: [parentItemId] };
  }

  // derived joined values → status label / text
  for (const d of (cfg.derived || [])) {
    let val = null;
    const fkVal = dbRow[d.fk];
    if (fkVal) {
      const row = await fetchRow(supabase, cache, d.table, fkVal, `id,${d.field}`);
      val = row?.[d.field] ?? null;
    }
    // The direct FK is the fast path; when the app doesn't populate it, a
    // resolver may reach the same value through the relations it does write.
    if ((val == null || String(val).trim() === '') && d.fallback) {
      val = await d.fallback({ supabase, dbRow, cache });
    }
    if (val == null || String(val).trim() === '') continue;
    out.fingerprint[d.column] = String(val);
    if (mode === 'update' && String(currentText(item, d.column) || '').trim() === String(val).trim()) continue; // unchanged
    out.colVals[d.column] = d.type === 'status' ? { label: String(val) } : String(val);
  }

  // computed columns → a value derived from this row itself (no join)
  for (const c of (cfg.computed || [])) {
    const val = c.build(dbRow);
    if (val == null || String(val).trim() === '') continue;
    out.fingerprint[c.column] = String(val);
    if (mode === 'update' && String(currentText(item, c.column) || '').trim() === String(val).trim()) continue; // unchanged
    out.colVals[c.column] = c.type === 'status' ? { label: String(val) } : String(val);
  }

  return out;
}
