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
import { tableForTarget, filtersForTarget } from './entities.js';
import { valuesEqual } from './compare.js';
import { coerceForDb, formatForMonday, LOOKUP_MAP } from './apply.js';
import { contentHash, getLink, isEcho, isEnrichEcho, recordSynced, valuesHash } from './loopGuard.js';
import { syncProductComponentFromMonday, syncProductComponentToMonday } from './productComponents.js';
import { creditNameFromTitle, enrichPush, hasComposedTitle, resolveInboundDerived, resolveInboundInherited, resolveInboundRelations, taskTextFromTitle } from './enrich.js';
import { findLinkedItem, withRecordLock } from './pushGuard.js';

const NAME_COLUMN = 'name';
// Entities whose "name" column maps to a system running-number (deal_number /
// payment_number) — never take those from Monday's display name, on create OR
// update. On create the DB default (make_business_number) generates the real
// running number; letting Monday's name land in deal_number both pollutes it and
// collides with the UNIQUE(deal_number) constraint whenever two Monday items
// share a display name, silently dropping the second item's inbound insert.
// For customers/leads/salespeople/credits the name IS the real name → sync it.
const NAME_INBOUND_SKIP = new Set(['deal', 'payment']);

function cellText(item, colId) {
  if (colId === NAME_COLUMN) return item.name;
  const c = item.columns[colId];
  return c ? c.text : null;
}

// Monday cell → the value the DB column should hold. Only the credit title needs
// reshaping: it is a composed LABEL on the board, while credits.credit_name holds
// the component's own name. See creditNameFromTitle — free-text titles pass through.
function inboundValue(entityType, mondayColumnId, text) {
  if (entityType === 'credit' && mondayColumnId === NAME_COLUMN) return creditNameFromTitle(text);
  return text;
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
  const targets = await getTargets(supabase, environment);
  const target = targets.find((t) => String(t.monday_board_id) === String(boardId)) || null;
  if (!target) return { status: 'skipped', reason: `no target for board ${boardId}` };
  if (target.inbound_enabled === false) return { status: 'skipped', reason: 'inbound disabled' };

  // The product<->component junction needs relation resolution, not the generic
  // scalar-field path. Delegate to its dedicated handler.
  if (target.entity_type === 'deal_product') {
    return syncProductComponentFromMonday({ supabase, monday, environment, itemId });
  }

  const item = await monday.getItem(itemId);
  if (!item) return { status: 'skipped', reason: 'monday item not found' };

  const { table, fields, nameField, dbTypes, notNull } = await loadContext(supabase, monday, target);

  // Echo check: is this webhook just the reflection of a scalar write we made?
  const mondayHash = contentHash(fields, (f) => cellText(item, f.monday_column_id));
  const link = await getLink(supabase, { environment, entityType: target.entity_type, boardId, itemId });
  const scalarEcho = isEcho(link, 'monday', mondayHash);

  const linked = await supabase.select(table, {
    filters: [`monday_board_id=eq.${boardId}`, `monday_item_id=eq.${itemId}`], limit: 1,
  });
  let dbRow = linked[0] || null;

  // Inbound board_relation → FK resolution (payment→deal/salesperson, lead→salesperson).
  // Runs even on a scalar echo: linking a deal to an already-created payment leaves
  // the scalars unchanged, so relation changes must not be suppressed by the echo
  // guard. Idempotent — only FKs that actually change are written.
  const boardByEntity = Object.fromEntries(
    targets.filter((t) => t.monday_board_id).map((t) => [t.entity_type, String(t.monday_board_id)]),
  );
  const resolvedRel = await resolveInboundRelations({ supabase, entityType: target.entity_type, item, boardByEntity, environment });
  const relPatch = {};
  for (const [fk, val] of Object.entries(resolvedRel)) {
    if (!dbRow || !valuesEqual(dbRow[fk], val)) relPatch[fk] = val;
  }

  // Status columns whose labels name a row elsewhere (customer → first
  // salesperson): label text → FK. Same rules as relations — runs on an echo
  // too, only changed FKs are written, an unknown label is skipped.
  const resolvedDerived = await resolveInboundDerived({ supabase, entityType: target.entity_type, item, environment });
  for (const [fk, val] of Object.entries(resolvedDerived)) {
    if (!dbRow || !valuesEqual(dbRow[fk], val)) relPatch[fk] = val;
  }

  // Fields the child inherits from that parent (payment → deal's customer /
  // salesperson). The payments board carries no customer column, so without this
  // a Monday-created payment reaches the DB with customer_id NULL. Filled here
  // rather than left to the app: same event, same write. Fills empty fields only.
  const inherited = await resolveInboundInherited({
    supabase, entityType: target.entity_type, dbRow, resolved: resolvedRel,
  });
  for (const [f, val] of Object.entries(inherited)) relPatch[f] = val;

  // True echo with no relation change → nothing to do.
  if (dbRow && scalarEcho && Object.keys(relPatch).length === 0) {
    return { status: 'skipped', reason: 'echo' };
  }

  // Build scalar field changes (Monday text → DB column). Skipped on a scalar echo
  // (the scalars already match what we last wrote) — only relations are applied then.
  const changes = scalarEcho ? [] : fields
    .filter((f) => f.monday_column_id !== NAME_COLUMN || !NAME_INBOUND_SKIP.has(target.entity_type))
    .map((f) => ({ field: f.source_field,
      to: inboundValue(target.entity_type, f.monday_column_id, cellText(item, f.monday_column_id)) }));

  // A coordination task is titled "customer | task text" — keep only the text.
  // The customer comes from the task's deal (existing row, or the link resolved
  // just above on create), so this needs the DB and cannot live in inboundValue.
  if (target.entity_type === 'coordination_task') {
    const nameChange = changes.find((ch) => ch.field === nameField);
    if (nameChange) {
      nameChange.to = await taskTextFromTitle({
        supabase, title: nameChange.to, dealId: relPatch.deal_id || dbRow?.deal_id || null,
      });
    }
  }

  if (changes.length) await ensureLookups(supabase, target.entity_type, changes);

  let op;
  if (!dbRow) {
    if (target.create_enabled === false) return { status: 'skipped', reason: 'create disabled' };
    const record = {};
    for (const ch of changes) {
      const v = coerceForDb(ch.to, dbTypes[ch.field]);
      if (v === null && notNull.has(ch.field)) continue;
      record[ch.field] = v;
    }
    Object.assign(record, relPatch); // resolved parent FKs (deal_id, salesperson_id, …)
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
    Object.assign(patch, relPatch); // backfill/re-parent resolved FKs
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

// ── Monday item deleted / archived → soft-delete the DB row ───────────
// Logical delete only: set deleted_at so foreign-key relationships from other
// entities stay intact — NO hard delete, NO cascade. Tables without a
// deleted_at column (e.g. deal_coordination_tasks) are skipped.
export async function softDeleteFromMonday({ supabase, environment, boardId, itemId }) {
  const target = await findTargetByBoard(supabase, environment, boardId);
  if (!target) return { status: 'skipped', reason: `no target for board ${boardId}` };
  const table = tableForTarget(target);
  const schema = await supabase.introspect();
  const cols = new Set((schema[table] || []).map((c) => c.name));
  if (!cols.has('deleted_at')) return { status: 'skipped', reason: `${table} has no deleted_at (soft-delete unsupported)` };

  const rows = await supabase.select(table, {
    columns: 'id,deleted_at',
    filters: [`monday_board_id=eq.${boardId}`, `monday_item_id=eq.${itemId}`], limit: 1,
  });
  const row = rows[0];
  if (!row) return { status: 'skipped', reason: 'no DB row linked to the deleted/archived item' };
  if (row.deleted_at) return { status: 'skipped', reason: 'already soft-deleted' };

  const now = new Date().toISOString();
  await supabase.updateById(table, row.id, { deleted_at: now });

  // Catalog cascade: a product↔component junction row has no meaning once one of
  // its parents is gone. Deleting a product or component in Monday therefore also
  // soft-deletes its product_components links, so the product stops showing the
  // deleted component. This cascade is CATALOG-ONLY — financial entities
  // (deal/payment/credit) keep the no-cascade rule to preserve FK history.
  let cascaded = 0;
  const CATALOG_CASCADE = { product: 'product_id', component_operation: 'component_id' };
  const fk = CATALOG_CASCADE[target.entity_type];
  if (fk) {
    const links = await supabase.select('product_components', {
      columns: 'id', filters: [`${fk}=eq.${row.id}`, 'deleted_at=is.null'],
    }).catch(() => []);
    for (const l of links) {
      await supabase.updateById('product_components', l.id, { deleted_at: now });
      cascaded++;
    }
  }
  return { status: 'ok', op: 'soft_delete', entity: target.entity_type, table, dbId: row.id, itemId, cascaded };
}

// ── DB → Monday (process #4) ──────────────────────────────────────────
export async function syncItemToMonday({ supabase, monday, environment, entityType, dbId }) {
  // The product<->component junction needs relation writing, not the generic path.
  if (entityType === 'deal_product') {
    return syncProductComponentToMonday({ supabase, monday, environment, dbId });
  }
  // Serialise pushes of the SAME record: the create path is a check-then-create
  // whose middle (enrichment + createItem) takes seconds, and two overlapping
  // cascades of one deal would otherwise each create an item for every child.
  return withRecordLock(`${environment}:${entityType}:${dbId}`, () => pushRecordToMonday({ supabase, monday, environment, entityType, dbId }));
}

async function pushRecordToMonday({ supabase, monday, environment, entityType, dbId }) {
  const targets = await getTargets(supabase, environment);
  const target = targets.find((t) => t.entity_type === entityType && t.is_active !== false) || null;
  if (!target) return { status: 'skipped', reason: `no active target for ${entityType}` };
  if (target.outbound_enabled === false) return { status: 'skipped', reason: 'outbound disabled' };
  // entity_type → this env's board id, to guard cross-env relation links.
  const boardByEntity = Object.fromEntries(targets.filter((t) => t.monday_board_id).map((t) => [t.entity_type, String(t.monday_board_id)]));

  const { table, mappings, fields, nameField, monTypes } = await loadContext(supabase, monday, target);
  const boardId = target.monday_board_id;

  // filtersForTarget guards salespeople: a non-sales app_users row won't match,
  // so it is skipped rather than pushed to the salespeople board.
  const rows = await supabase.select(table, { filters: [`id=eq.${dbId}`, ...filtersForTarget(target)], limit: 1 });
  const dbRow = rows[0];
  if (!dbRow) return { status: 'skipped', reason: `db row not found (or excluded by entity filter) for ${entityType} id ${dbId}` };

  const supabaseHash = contentHash(fields, (f) => dbRow[f.source_field]);
  const linkedHere = dbRow.monday_board_id && String(dbRow.monday_board_id) === String(boardId) && dbRow.monday_item_id;
  let itemId = linkedHere ? String(dbRow.monday_item_id) : null;

  // The row says "no item yet" — but the link table is the authority on what we
  // already created for it. A write-back that failed (or a concurrent push in
  // another instance) must not turn into a second Monday item; adopt the
  // existing one and repair the row instead.
  if (!itemId) {
    const adopted = await findLinkedItem({ supabase, monday, target, entityType, dbId: dbRow.id, boardId });
    if (adopted) {
      itemId = adopted;
      await supabase.updateById(table, dbRow.id, {
        monday_board_id: String(boardId), monday_item_id: adopted,
      }).catch(() => {});
    }
  }

  let resultItemId = itemId;
  let op;
  let enrichHash = null;
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
    enrichHash = valuesHash(enr.fingerprint);
    const itemName = enr.title || String(dbRow[nameField] || 'ללא שם');
    const created = await monday.createItem(boardId, target.monday_group_id, itemName, colVals);
    resultItemId = created?.id ? String(created.id) : null;
    if (resultItemId) {
      // A lost write-back is what turns the NEXT push into a duplicate item —
      // never swallow it silently.
      await supabase.updateById(table, dbRow.id, {
        monday_board_id: String(boardId), monday_item_id: resultItemId,
      }).catch((e) => console.error(`[push] link write-back FAILED ${entityType} ${dbRow.id} → item ${resultItemId}: ${e.message}`));
    }
    op = 'create';
  } else {
    // Update only changed columns (fetch current item to diff).
    const item = await monday.getItem(itemId);

    // Backfill board_relation links + derived columns that are missing/changed
    // (fixes "deal opened, credits opened, but no link created"). Resolved BEFORE
    // the echo check because the guard needs its fingerprint — an enriched value
    // read from a joined table (a credit's quote note, a payment's salesperson)
    // changes without touching any mapped field, and skipping on the mapped hash
    // alone would strand it in the DB.
    const enr = await enrichPush({ supabase, target, dbRow, mode: 'update', item, boardByEntity });
    enrichHash = valuesHash(enr.fingerprint);

    const link = await getLink(supabase, { environment, entityType, boardId, itemId });
    if (isEcho(link, 'supabase', supabaseHash) && isEnrichEcho(link, enrichHash)) {
      return { status: 'skipped', reason: 'echo' };
    }

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
    Object.assign(colVals, enr.colVals);
    // A composed title that tracks a DB field (coordination task) is re-written
    // when it drifted; the date-stamped ones never set enr.title on update.
    if (enr.title) colVals[NAME_COLUMN] = String(enr.title);
    if (Object.keys(colVals).length === 0) {
      const mondayHashNow = item ? contentHash(fields, (f) => cellText(item, f.monday_column_id)) : supabaseHash;
      await recordSynced(supabase, {
        environment, entityType, boardId, itemId,
        targetId: target.id, sourceRecordId: dbRow.id, source: 'supabase',
        mondayHash: mondayHashNow, supabaseHash, enrichHash,
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
    mondayHash, supabaseHash, enrichHash,
  });
  return { status: 'ok', op, side: 'monday', entity: entityType, dbId: dbRow.id, itemId: resultItemId };
}

// ── Deal cascade (process #4c: deal_created) ──────────────────────────
// Pushes the deal graph the app just wrote: deal + customer (if created) +
// the deal's lead + payments + credits + coordination tasks.
export async function syncDealGraph({ supabase, monday, environment, dealId, includeCustomerId, includeLeadId }) {
  const out = [];
  const push = async (entityType, id) => {
    if (!id) return;
    try { out.push({ entity: entityType, id, ...(await syncItemToMonday({ supabase, monday, environment, entityType, dbId: id })) }); }
    catch (e) { out.push({ entity: entityType, id, status: 'error', error: e.message }); }
  };

  await push('deal', dealId);

  // The customer and the lead ALWAYS ride the cascade. The caller may name them
  // (includeCustomerId / includeLeadId) but historically the app passed neither:
  // in production not one lead had ever been pushed DB→Monday (787/787 links
  // last_source='monday'). So resolve deals.customer_id / deals.lead_id ourselves.
  // Lead: this is what carries the "deal opened → 'לקוח פעיל'" status (migration
  // 016) to Monday. Customer: a deal stamps customers.first_salesperson_id on the
  // customer's FIRST deal (write-once), and that value only reaches the board's
  // "איש מכירות ראשון" status if the customer is pushed here. DB→Monday runs on
  // THIS path only; the scheduled sync is Monday→DB, so an unpushed value is
  // overwritten on the next pull instead of reaching the board.
  let customerId = includeCustomerId;
  let leadId = includeLeadId;
  if (!customerId || !leadId) {
    const rows = await supabase.select('deals', { columns: 'customer_id,lead_id', filters: [`id=eq.${dealId}`], limit: 1 }).catch(() => []);
    customerId = customerId || rows[0]?.customer_id || null;
    leadId = leadId || rows[0]?.lead_id || null;
  }
  await push('customer', customerId);
  await push('lead', leadId);

  // Children linked by deal_id.
  for (const [entityType, childTable] of [['payment', 'payments'], ['credit', 'credits'], ['coordination_task', 'deal_coordination_tasks']]) {
    const children = await supabase.select(childTable, { columns: 'id', filters: [`deal_id=eq.${dealId}`] }).catch(() => []);
    for (const c of children) await push(entityType, c.id);
  }
  return { status: 'ok', dealId, results: out };
}
