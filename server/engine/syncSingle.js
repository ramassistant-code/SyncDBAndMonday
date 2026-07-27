// Real-time single-item sync in both directions, with loop/echo suppression.
//
// Used by the webhook receivers:
//   • Monday webhook  → syncItemFromMonday()  (Monday → DB)   — processes #1/#2
//   • App webhook     → syncItemToMonday()     (DB → Monday)   — process #4
//
// Unlike the batch engine (which diffs a whole board), these fetch ONE record
// per side so a webhook is cheap even on a 2,800-row board. Every write is
// wrapped by loopGuard: an inbound event that only echoes our own last write is
// skipped, and after a successful sync BOTH sides' hashes are recorded so the
// far-side write that follows is recognised as an echo and the loop stops.

import { getTargets, getFieldMappings } from '../controlPlane.js';
import { tableForTarget } from './entities.js';
import { valuesEqual } from './compare.js';
import { coerceForDb, formatForMonday, LOOKUP_MAP } from './apply.js';
import { contentHash, getLink, isEcho, recordSynced } from './loopGuard.js';
import { syncProductComponentFromMonday } from './productComponents.js';
import { enrichPush, hasComposedTitle } from './enrich.js';

const NAME_COLUMN = 'name';
// Entities whose "name" column maps to a system running-number (deal_number /
// payment_number) — never overwrite those from Monday's display name on update.
// For customers/leads/salespeople/credits the name IS the real name → sync it.
const NAME_INBOUND_SKIP = new Set(['deal', 'payment']);

function cellText(item, colId) {
  if (colId === NAME_COLUMN) return item.name;
  const c = item.columns[colId];
  return c ? c.text : null;
}

// Resolve everything needed to sync one target: mappings, hashable field list,
// DB column types + NOT-NULL set, Monday column types, and the name field.
async function loadContext(supabase, monday, target) {
  const table = tableForTarget(target);
  const mappings = (await getFieldMappings(supabase, target.id))
    .filter((m) => m.source_field && m.monday_column_id);
  const fields = mappings.map((m) => ({ monday_column_id: m.monday_column_id, source_field: m.source_field }));
  const nameMap = mappings.find((m) => m.monday_column_id === NAME_COLUMN);
  const nameField = nameMap ? nameMap.source_field : 'name';
  const schema = await supabase.introspect();
  const dbTypes = Object.fromEntries((schema[table] || []).map((c) => [c.name, c.type]));
  const notNull = (await supabase.notNullColumns())[table] || new Set();
  const boardMeta = await monday.getBoardMeta(target.monday_board_id);
  const monTypes = Object.fromEntries((boardMeta?.columns || []).map((c) => [c.id, c.type]));
  return { table, mappings, fields, nameField, dbTypes, notNull, monTypes };
}

async function findTargetByBoard(supabase, environment, boardId) {
  const targets = await getTargets(supabase, environment);
  return targets.find((t) => String(t.monday_board_id) === String(boardId)) || null;
}
// Insert any lookup values referenced by `changes` that are missing from their
// curated lookup table (Monday = source of truth), mirroring apply.js.
async function ensureLookups(supabase, entityType, changes) {
  const map = LOOKUP_MAP[entityType];
  if (!map) return { added: 0 };
  const needed = {};
  for (const ch of changes) {
    const lt = map[ch.field];
    if (!lt) continue;
    const v = ch.to == null ? '' : String(ch.to).trim();
    if (v) (needed[lt] ||= new Set()).add(v);
  }
  let added = 0;
  for (const [lt, vals] of Object.entries(needed)) {
    const existing = await supabase.select(lt, { columns: 'value' });
    const have = new Set(existing.map((r) => r.value));
    const missing = [...vals].filter((v) => !have.has(v));
    if (missing.length) {
      await supabase.insert(lt, missing.map((v) => ({ value: v, is_active: true, sort_order: 100 })));
      added += missing.length;
    }
  }
  return { added };
}

// ── Monday → DB (processes #1/#2) ─────────────────────────────────────
export async function syncItemFromMonday({ supabase, monday, environment, boardId, itemId }) {
  const target = await findTargetByBoard(supabase, environment, boardId);
  if (!target) return { status: 'skipped', reason: `no target for board ${boardId}` };
  if (target.inbound_enabled === false) return { status: 'skipped', reason: 'inbound disabled' };

  // The product<->component junction needs relation resolution, not the generic
  // scalar-field path. Delegate to its dedicated handler.
  if (target.entity_type === 'deal_product') {
    return syncProductComponentFromMonday({ supabase, monday, itemId });
  }

  const item = await monday.getItem(itemId);
  if (!item) return { status: 'skipped', reason: 'monday item not found' };

  const { table, fields, dbTypes, notNull } = await loadContext(supabase, monday, target);

  // Echo check: is this webhook just the reflection of a write we made?
  const mondayHash = contentHash(fields, (f) => cellText(item, f.monday_column_id));
  const link = await getLink(supabase, { environment, entityType: target.entity_type, boardId, itemId });
  if (isEcho(link, 'monday', mondayHash)) return { status: 'skipped', reason: 'echo' };

  const linked = await supabase.select(table, {
    filters: [`monday_board_id=eq.${boardId}`, `monday_item_id=eq.${itemId}`], limit: 1,
  });
  let dbRow = linked[0] || null;

  // Build field changes (Monday text → DB column).
  const changes = fields
    .filter((f) => f.monday_column_id !== NAME_COLUMN || dbRow == null || !NAME_INBOUND_SKIP.has(target.entity_type))
    .map((f) => ({ field: f.source_field, to: cellText(item, f.monday_column_id) }));

  await ensureLookups(supabase, target.entity_type, changes);

  let op;
  if (!dbRow) {
    if (target.create_enabled === false) return { status: 'skipped', reason: 'create disabled' };
    const record = {};
    for (const ch of changes) {
      const v = coerceForDb(ch.to, dbTypes[ch.field]);
      if (v === null && notNull.has(ch.field)) continue;
      record[ch.field] = v;
    }
    record.monday_board_id = String(boardId);
    record.monday_item_id = String(itemId);
    const created = await supabase.insert(table, [record]);
    dbRow = Array.isArray(created) ? created[0] : created;
    op = 'create';
  } else {
    const patch = {};
    for (const ch of changes) {
      if (valuesEqual(dbRow[ch.field], ch.to)) continue; // unchanged
      const v = coerceForDb(ch.to, dbTypes[ch.field]);
      if (v === null && notNull.has(ch.field)) continue;
      patch[ch.field] = v;
    }
    if (Object.keys(patch).length === 0) {
      // Nothing to write, but remember the hashes so future echoes are caught.
      await recordSynced(supabase, {
        environment, entityType: target.entity_type, boardId, itemId,
        targetId: target.id, sourceRecordId: dbRow.id, source: 'monday',
        mondayHash, supabaseHash: contentHash(fields, (f) => dbRow[f.source_field]),
      });
      return { status: 'noop', dbId: dbRow.id };
    }
    const updated = await supabase.updateById(table, dbRow.id, patch);
    dbRow = updated || { ...dbRow, ...patch };
    op = 'update';
  }

  // Record both sides in sync. supabaseHash from the row as it now stands.
  const supabaseHash = contentHash(fields, (f) => dbRow[f.source_field]);
  await recordSynced(supabase, {
    environment, entityType: target.entity_type, boardId, itemId,
    targetId: target.id, sourceRecordId: dbRow.id, source: 'monday',
    mondayHash, supabaseHash,
  });
  return { status: 'ok', op, side: 'db', entity: target.entity_type, dbId: dbRow.id, itemId };
}

// ── DB → Monday (process #4) ──────────────────────────────────────────
export async function syncItemToMonday({ supabase, monday, environment, entityType, dbId }) {
  const targets = await getTargets(supabase, environment);
  const target = targets.find((t) => t.entity_type === entityType && t.is_active !== false) || null;
  if (!target) return { status: 'skipped', reason: `no active target for ${entityType}` };
  if (target.outbound_enabled === false) return { status: 'skipped', reason: 'outbound disabled' };
  // entity_type → this env's board id, to guard cross-env relation links.
  const boardByEntity = Object.fromEntries(targets.filter((t) => t.monday_board_id).map((t) => [t.entity_type, String(t.monday_board_id)]));

  const { table, mappings, fields, nameField, monTypes } = await loadContext(supabase, monday, target);
  const boardId = target.monday_board_id;

  const rows = await supabase.select(table, { filters: [`id=eq.${dbId}`], limit: 1 });
  const dbRow = rows[0];
  if (!dbRow) return { status: 'skipped', reason: 'db row not found' };

  const supabaseHash = contentHash(fields, (f) => dbRow[f.source_field]);
  const linkedHere = dbRow.monday_board_id && String(dbRow.monday_board_id) === String(boardId) && dbRow.monday_item_id;
  const itemId = linkedHere ? String(dbRow.monday_item_id) : null;

  // Echo check on the DB side (only meaningful for an already-linked row).
  if (itemId) {
    const link = await getLink(supabase, { environment, entityType, boardId, itemId });
    if (isEcho(link, 'supabase', supabaseHash)) return { status: 'skipped', reason: 'echo' };
  }

  let resultItemId = itemId;
  let op;
  if (!itemId) {
    if (target.create_enabled === false) return { status: 'skipped', reason: 'create disabled' };
    const colVals = {};
    for (const m of mappings) {
      if (m.monday_column_id === NAME_COLUMN) continue;
      const f = formatForMonday(dbRow[m.source_field], monTypes[m.monday_column_id]);
      if (f !== undefined) colVals[m.monday_column_id] = f;
    }
    // Composed title + board_relation links + derived columns (req 5/6/7/8).
    const enr = await enrichPush({ supabase, target, dbRow, mode: 'create', boardByEntity });
    Object.assign(colVals, enr.colVals);
    const itemName = enr.title || String(dbRow[nameField] || 'ללא שם');
    const created = await monday.createItem(boardId, target.monday_group_id, itemName, colVals);
    resultItemId = created?.id ? String(created.id) : null;
    if (resultItemId) {
      await supabase.updateById(table, dbRow.id, {
        monday_board_id: String(boardId), monday_item_id: resultItemId,
      }).catch(() => {});
    }
    op = 'create';
  } else {
    // Update only changed columns (fetch current item to diff).
    const item = await monday.getItem(itemId);
    const colVals = {};
    for (const m of mappings) {
      // The composed title is DB-owned and written on create only — never
      // overwrite it with the business key (deal_number/…) on update. Only for
      // entities with a COMPOSED title (deal/payment/credit) — salesperson's
      // title is its full_name and must keep syncing.
      if (m.monday_column_id === NAME_COLUMN && hasComposedTitle(entityType)) continue;
      const cur = item ? cellText(item, m.monday_column_id) : null;
      if (valuesEqual(dbRow[m.source_field], cur)) continue; // unchanged
      const f = formatForMonday(dbRow[m.source_field], monTypes[m.monday_column_id]);
      if (f !== undefined) colVals[m.monday_column_id] = f;
    }
    // Backfill board_relation links + derived columns that are missing/changed
    // (fixes "deal opened, credits opened, but no link created").
    const enr = await enrichPush({ supabase, target, dbRow, mode: 'update', item, boardByEntity });
    Object.assign(colVals, enr.colVals);
    if (Object.keys(colVals).length === 0) {
      const mondayHashNow = item ? contentHash(fields, (f) => cellText(item, f.monday_column_id)) : supabaseHash;
      await recordSynced(supabase, {
        environment, entityType, boardId, itemId,
        targetId: target.id, sourceRecordId: dbRow.id, source: 'supabase',
        mondayHash: mondayHashNow, supabaseHash,
      });
      return { status: 'noop', itemId };
    }
    await monday.changeColumnValues(boardId, itemId, colVals);
    op = 'update';
  }

  if (!resultItemId) return { status: 'failed', reason: 'no monday item id after write' };

  // Re-read the item to record the authoritative Monday-side hash.
  const after = await monday.getItem(resultItemId);
  const mondayHash = after ? contentHash(fields, (f) => cellText(after, f.monday_column_id)) : supabaseHash;
  await recordSynced(supabase, {
    environment, entityType, boardId, itemId: resultItemId,
    targetId: target.id, sourceRecordId: dbRow.id, source: 'supabase',
    mondayHash, supabaseHash,
  });
  return { status: 'ok', op, side: 'monday', entity: entityType, dbId: dbRow.id, itemId: resultItemId };
}

// ── Deal cascade (process #4c: deal_created) ──────────────────────────
// Pushes the deal graph the app just wrote: deal + customer (if created) +
// lead (if relinked) + payments + credits + coordination tasks.
export async function syncDealGraph({ supabase, monday, environment, dealId, includeCustomerId, includeLeadId }) {
  const out = [];
  const push = async (entityType, id) => {
    if (!id) return;
    try { out.push({ entity: entityType, id, ...(await syncItemToMonday({ supabase, monday, environment, entityType, dbId: id })) }); }
    catch (e) { out.push({ entity: entityType, id, status: 'error', error: e.message }); }
  };

  await push('deal', dealId);
  await push('customer', includeCustomerId);
  await push('lead', includeLeadId);

  // Children linked by deal_id.
  for (const [entityType, childTable] of [['payment', 'payments'], ['credit', 'credits'], ['coordination_task', 'deal_coordination_tasks']]) {
    const children = await supabase.select(childTable, { columns: 'id', filters: [`deal_id=eq.${dealId}`] }).catch(() => []);
    for (const c of children) await push(entityType, c.id);
  }
  return { status: 'ok', dealId, results: out };
}
