// One-time reconciliation ("יישור קו"): links existing DB rows to the items of
// the target's Monday board by a natural key, BEFORE the first id-based sync,
// so records are updated in place instead of duplicated.
//
// Match order per entity (first key that yields a match wins).
// On ambiguity, prefer the row already linked to a *different* board (the
// production-seeded row); otherwise flag the item for manual review.

import { getFieldMappings } from '../controlPlane.js';
import { tableForTarget } from './entities.js';
import { normalizePhone, normalizeEmail, normalizeName } from './compare.js';

const MATCH_KEYS = {
  customer: ['phone', 'email', 'name'],
  lead: ['phone', 'email', 'name'],
  payment: ['name'],
  deal: ['name'],
  credit: ['name'],
  default: ['name'],
};

const normalizers = { phone: normalizePhone, email: normalizeEmail, name: normalizeName };

// Relational children matched by amount + the customer name in the item title.
const COMPOSITE = {
  deal: { amountFields: ['total_amount_including_vat', 'total_amount'], amountMapField: 'total_amount_including_vat' },
  payment: { amountFields: ['amount_paid'], amountMapField: 'amount_paid' },
};

export async function buildAlignment({ supabase, monday, target }) {
  const boardId = target.monday_board_id;
  if (!boardId || boardId === 'CONFIGURE_BOARD_ID') {
    const e = new Error(`Target "${target.target_key}" has no valid monday_board_id`); e.status = 422; throw e;
  }
  const boardStr = String(boardId);
  const table = tableForTarget(target);
  const mappings = await getFieldMappings(supabase, target.id);
  const warnings = [];
  const keys = MATCH_KEYS[target.entity_type] || MATCH_KEYS.default;
  const schema = await supabase.introspect();
  const colNames = new Set((schema[table] || []).map((c) => c.name));

  // The DB field mapped to Monday's item title. For customers/leads this is
  // 'name'; for deals/payments/credits it's the business number (deal_number…).
  const nameField = mappings.find((m) => m.monday_column_id === 'name')?.source_field || 'name';
  const colFor = (field) => mappings.find((m) => m.source_field === field)?.monday_column_id;

  // Relational children (deals/payments) have no single natural key. The DB
  // rows already carry the correct parent FKs (seeded from prod) — they only
  // need LINKING. Match by amount + the customer name embedded in the title.
  if (COMPOSITE[target.entity_type]) {
    return alignComposite({ supabase, monday, target, boardStr, table, colFor, colNames });
  }

  // Resolve each semantic match key → { key, dbField, mondayCol, norm }.
  const keyDefs = [];
  for (const k of keys) {
    if (k === 'name') keyDefs.push({ key: 'name', dbField: nameField, mondayCol: 'name', norm: normalizeName });
    else if (k === 'phone') keyDefs.push({ key: 'phone', dbField: colNames.has('normalized_phone') ? 'normalized_phone' : 'phone', mondayCol: colFor('phone'), norm: normalizePhone });
    else if (k === 'email') keyDefs.push({ key: 'email', dbField: 'email', mondayCol: colFor('email'), norm: normalizeEmail });
  }
  const activeDefs = keyDefs.filter((d) => d.mondayCol && colNames.has(d.dbField));

  // DB columns needed.
  const wanted = new Set(['id', 'monday_board_id', 'monday_item_id', nameField, ...activeDefs.map((d) => d.dbField), 'phone', 'email']);
  const dbColumns = [...wanted].filter((c) => colNames.has(c)).join(',');

  const [dbRows, items] = await Promise.all([
    colNames.has('deleted_at')
      ? supabase.select(table, { columns: dbColumns, filters: ['deleted_at=is.null'] })
      : supabase.select(table, { columns: dbColumns }),
    monday.getItems(boardId),
  ]);

  const dbVal = (row, def) => def.norm(row[def.dbField]);
  const monVal = (item, def) => (def.key === 'name'
    ? normalizeName(item.name)
    : def.norm(item.columns[def.mondayCol] ? item.columns[def.mondayCol].text : ''));

  const index = Object.fromEntries(activeDefs.map((d) => [d.key, new Map()]));
  const alignedByItem = new Map();
  for (const r of dbRows) {
    if (r.monday_board_id && String(r.monday_board_id) === boardStr && r.monday_item_id) {
      alignedByItem.set(String(r.monday_item_id), r);
    }
    for (const def of activeDefs) {
      const v = dbVal(r, def);
      if (!v) continue;
      if (!index[def.key].has(v)) index[def.key].set(v, []);
      index[def.key].get(v).push(r);
    }
  }

  const rows = [];
  const counts = { link: 0, review: 0, new: 0, alreadyAligned: 0 };
  const usedDbIds = new Set();

  for (const item of items) {
    if (alignedByItem.has(String(item.id))) { counts.alreadyAligned++; continue; }

    let cands = null, matchedBy = null;
    for (const def of activeDefs) {
      const v = monVal(item, def);
      if (v && index[def.key].has(v)) { cands = index[def.key].get(v); matchedBy = def.key; break; }
    }

    if (!cands) {
      rows.push({ key: 'mon:' + item.id, op: 'new', mondayItemId: item.id, name: item.name, matchedBy: null });
      counts.new++;
      continue;
    }

    const available = cands.filter((r) => !usedDbIds.has(r.id));
    const pool = available.length ? available : cands;
    const resolved = resolve(pool, boardStr);
    if (resolved.op === 'link') {
      usedDbIds.add(resolved.row.id);
      rows.push({ key: 'mon:' + item.id, op: 'link', mondayItemId: item.id, name: item.name,
        matchedBy, dbId: resolved.row.id,
        dbRow: { name: resolved.row[nameField], phone: resolved.row.phone, email: resolved.row.email, board: resolved.row.monday_board_id } });
      counts.link++;
    } else {
      rows.push({ key: 'mon:' + item.id, op: 'review', mondayItemId: item.id, name: item.name, matchedBy,
        candidates: pool.slice(0, 6).map((r) => ({ id: r.id, name: r[nameField], phone: r.phone, email: r.email, board: r.monday_board_id })) });
      counts.review++;
    }
  }

  return {
    target: { key: target.target_key, name: target.target_name, entity_type: target.entity_type, table, board_id: boardStr },
    matchKeys: activeDefs.map((d) => d.key),
    warnings,
    counts,
    totals: { db: dbRows.length, monday: items.length },
    rows,
  };
}

function resolve(cands, boardStr) {
  if (cands.length === 1) return { op: 'link', row: cands[0] };
  // prefer a single row already linked to a *different* board (the seeded/prod row)
  const prodLinked = cands.filter((r) => r.monday_board_id && String(r.monday_board_id) !== boardStr);
  if (prodLinked.length === 1) return { op: 'link', row: prodLinked[0] };
  return { op: 'review', cands };
}

const roundAmt = (v) => {
  const n = Number(String(v == null ? '' : v).replace(/,/g, ''));
  return Number.isFinite(n) && n !== 0 ? Math.round(n) : null;
};

// Composite alignment for relational children (deals/payments): the DB rows
// already hold the correct parent FKs, so we only LINK them to the board items,
// matching on amount + the customer name embedded in the Monday item title.
async function alignComposite({ supabase, monday, target, boardStr, table, colFor, colNames }) {
  const cfg = COMPOSITE[target.entity_type];
  const amountCol = colFor(cfg.amountMapField);
  if (!amountCol) { const e = new Error(`No Monday amount column mapped for ${target.entity_type}`); e.status = 422; throw e; }

  // customer_id → normalized customer name
  const custs = await supabase.select('customers', { columns: 'id,name' });
  const custName = new Map(custs.map((c) => [c.id, normalizeName(c.name)]));

  const dbCols = ['id', 'monday_board_id', 'monday_item_id', 'customer_id', ...cfg.amountFields].filter((c) => colNames.has(c) || c === 'id');
  const dbRows = colNames.has('deleted_at')
    ? await supabase.select(table, { columns: dbCols.join(','), filters: ['deleted_at=is.null'] })
    : await supabase.select(table, { columns: dbCols.join(',') });
  const items = await monday.getItems(boardStr);

  // index DB rows by every rounded amount they expose
  const byAmt = new Map();
  const alignedByItem = new Map();
  for (const r of dbRows) {
    if (r.monday_board_id && String(r.monday_board_id) === boardStr && r.monday_item_id) {
      alignedByItem.set(String(r.monday_item_id), r);
    }
    const seen = new Set();
    for (const f of cfg.amountFields) {
      const a = roundAmt(r[f]);
      if (a == null || seen.has(a)) continue;
      seen.add(a);
      if (!byAmt.has(a)) byAmt.set(a, []);
      byAmt.get(a).push(r);
    }
  }

  const rows = [];
  const counts = { link: 0, review: 0, new: 0, alreadyAligned: 0 };
  const used = new Set();
  for (const item of items) {
    if (alignedByItem.has(String(item.id))) { counts.alreadyAligned++; continue; }
    const a = roundAmt(item.columns[amountCol] ? item.columns[amountCol].text : null);
    const title = normalizeName(item.name);
    const cands = (a != null ? (byAmt.get(a) || []) : []).filter((r) => !used.has(r.id));
    const named = cands.filter((r) => {
      const n = custName.get(r.customer_id);
      return n && n.length > 1 && title.includes(n);
    });
    if (named.length === 1) {
      used.add(named[0].id);
      rows.push({ key: 'mon:' + item.id, op: 'link', mondayItemId: item.id, name: item.name,
        matchedBy: 'amount+customer', dbId: named[0].id,
        dbRow: { name: custName.get(named[0].customer_id), amount: a } });
      counts.link++;
    } else if (named.length > 1) {
      rows.push({ key: 'mon:' + item.id, op: 'review', mondayItemId: item.id, name: item.name, matchedBy: 'amount+customer',
        candidates: named.slice(0, 6).map((r) => ({ id: r.id, name: custName.get(r.customer_id), amount: a })) });
      counts.review++;
    } else {
      rows.push({ key: 'mon:' + item.id, op: 'new', mondayItemId: item.id, name: item.name, matchedBy: null });
      counts.new++;
    }
  }

  return {
    target: { key: target.target_key, name: target.target_name, entity_type: target.entity_type, table, board_id: boardStr },
    matchKeys: ['amount+customer'],
    warnings: ['יישור מורכב (סכום + שם לקוח בכותרת): מקשר שורות DB קיימות עם ה-FK שלהן. דו-משמעי → לבדיקה, ללא התאמה → מדולג.'],
    counts,
    totals: { db: dbRows.length, monday: items.length },
    rows,
  };
}

export async function applyAlignment({ supabase, monday, target, selectedKeys }) {
  const table = tableForTarget(target);
  const boardStr = String(target.monday_board_id);
  const plan = await buildAlignment({ supabase, monday, target });
  const wanted = selectedKeys ? new Set(selectedKeys) : null;
  const links = plan.rows.filter((r) => r.op === 'link' && r.dbId)
    .filter((r) => (wanted ? wanted.has(r.key) : true));

  const summary = { target: target.target_key, requested: links.length, linked: 0, failed: 0, results: [], startedAt: new Date().toISOString() };
  for (const r of links) {
    try {
      await supabase.updateById(table, r.dbId, { monday_board_id: boardStr, monday_item_id: String(r.mondayItemId) });
      summary.linked++;
      summary.results.push({ key: r.key, name: r.name, dbId: r.dbId, mondayItemId: r.mondayItemId });
    } catch (e) {
      summary.failed++;
      summary.results.push({ key: r.key, name: r.name, dbId: r.dbId, error: e.message });
    }
  }
  summary.finishedAt = new Date().toISOString();
  return summary;
}
