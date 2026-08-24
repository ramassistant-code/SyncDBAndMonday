// Executes an approved sync plan for one target/direction and returns a summary.
// Writes are type-aware: DB writes coerce to the column's Postgres type; Monday
// writes format each value to the column's Monday type.

import { getFieldMappings, getTargets } from '../controlPlane.js';
import { buildDiff } from './diff.js';
import { tableForTarget } from './entities.js';
import { enrichPush, hasPushConfig, hasComposedTitle, makeEnrichCache } from './enrich.js';
import { findLinkedItem } from './pushGuard.js';

// DB columns constrained by a FK to a curated lookup table (keyed by `value`).
// When Monday holds a status option missing from the lookup, an insert/update
// would violate the FK — so we auto-extend the lookup (Monday = source of truth).
export const LOOKUP_MAP = {
  lead: {
    status: 'lookup_lead_status',
    answer_status: 'lookup_answer_status',
    capture_attempt_status: 'lookup_capture_attempt',
    lead_source: 'lookup_lead_source',
    rejection_reason: 'lookup_rejection_reason',
  },
  customer: {
    customer_type: 'lookup_customer_type',
    industry: 'lookup_industry',
    account_manager_contact_status: 'lookup_contact_status',
  },
};

// Ensure every lookup value referenced by the plan exists in its lookup table.
async function ensureLookups(supabase, entityType, planRows) {
  const map = LOOKUP_MAP[entityType];
  const result = { added: 0, details: {} };
  if (!map) return result;
  const needed = {}; // lookupTable -> Set(values)
  for (const row of planRows) {
    if (row.writeSide !== 'db') continue;
    for (const ch of row.changes) {
      const lt = map[ch.field];
      if (!lt) continue;
      const v = ch.to == null ? '' : String(ch.to).trim();
      if (v) (needed[lt] ||= new Set()).add(v);
    }
  }
  for (const [lt, vals] of Object.entries(needed)) {
    const existing = await supabase.select(lt, { columns: 'value' });
    const have = new Set(existing.map((r) => r.value));
    const missing = [...vals].filter((v) => !have.has(v));
    if (missing.length) {
      await supabase.insert(lt, missing.map((v) => ({ value: v, is_active: true, sort_order: 100 })));
      result.added += missing.length;
      result.details[lt] = missing;
    }
  }
  return result;
}

export async function applyPlan({ supabase, monday, target, direction, selectedKeys }) {
  const table = tableForTarget(target);
  const boardId = target.monday_board_id;

  // Recompute the diff server-side (never trust a client-sent plan for writes).
  const diff = await buildDiff({ supabase, monday, target, direction });
  const mappings = (await getFieldMappings(supabase, target.id))
    .filter((m) => m.source_field && m.monday_column_id);
  const nameMap = mappings.find((m) => m.monday_column_id === 'name');
  const nameField = nameMap ? nameMap.source_field : 'name';

  const wanted = selectedKeys ? new Set(selectedKeys) : null;
  const plan = diff.rows.filter((r) => r.op === 'create' || r.op === 'update')
    .filter((r) => (wanted ? wanted.has(r.key) : true));

  const summary = {
    target: target.target_key, direction,
    requested: plan.length,
    created: 0, updated: 0, skipped: 0, failed: 0,
    lookupsAdded: 0, lookupDetails: {},
    results: [], startedAt: new Date().toISOString(),
  };
  const enrichCache = makeEnrichCache();
  // entity_type → this env's board id (guards cross-env relation links on push).
  const boardByEntity = (direction === 'db_to_monday' || diff.rows.some((r) => r.writeSide === 'monday'))
    ? Object.fromEntries((await getTargets(supabase, target.environment)).filter((t) => t.monday_board_id).map((t) => [t.entity_type, String(t.monday_board_id)]))
    : {};

  // Auto-extend curated lookup tables so status values from Monday don't
  // violate FK constraints when writing to the DB.
  if (plan.some((r) => r.writeSide === 'db')) {
    const lk = await ensureLookups(supabase, target.entity_type, plan);
    summary.lookupsAdded = lk.added;
    summary.lookupDetails = lk.details;
  }

  // Respect the target's operation flags.
  const allowCreate = target.create_enabled !== false;
  const allowUpdate = target.update_enabled !== false;

  if (direction === 'db_to_monday' || diff.rows.some((r) => r.writeSide === 'monday')) {
    // Preload Monday column types for formatting.
    var boardMeta = await monday.getBoardMeta(boardId);
    var monTypes = Object.fromEntries((boardMeta?.columns || []).map((c) => [c.id, c.type]));
  }
  // Preload DB column types + NOT-NULL columns for safe coercion.
  const schema = await supabase.introspect();
  const dbTypes = Object.fromEntries((schema[table] || []).map((c) => [c.name, c.type]));
  const notNull = (await supabase.notNullColumns())[table] || new Set();

  for (const row of plan) {
    try {
      if (row.writeSide === 'db') {
        if (row.op === 'create') {
          if (!allowCreate) { summary.skipped++; continue; }
          const record = {};
          for (const ch of row.changes) {
            const v = coerceForDb(ch.to, dbTypes[ch.field]);
            if (v === null && notNull.has(ch.field)) continue; // don't write null into NOT-NULL
            record[ch.field] = v;
          }
          record.monday_board_id = String(boardId);
          record.monday_item_id = String(row.mondayItemId);
          const created = await supabase.insert(table, [record]);
          summary.created++;
          summary.results.push({ key: row.key, op: 'create', side: 'db', name: row.name, dbId: created?.[0]?.id });
        } else {
          if (!allowUpdate) { summary.skipped++; continue; }
          const patch = {};
          for (const ch of row.changes) {
            // The Monday item TITLE (name column) is written on CREATE only, not
            // UPDATE — mirroring the real-time path (syncSingle.js:101). For
            // relational children it is a display label ("customer | date"), so
            // writing it back would clobber the DB business key
            // (payment_number/deal_number) on every sync. DB owns the title
            // after creation.
            if (ch.mondayColumnId === 'name') continue;
            const v = coerceForDb(ch.to, dbTypes[ch.field]);
            if (v === null && notNull.has(ch.field)) continue; // keep existing value, don't null a NOT-NULL
            patch[ch.field] = v;
          }
          if (Object.keys(patch).length === 0) {
            summary.skipped++;
            summary.results.push({ key: row.key, op: 'update', side: 'db', name: row.name, skipped: 'אין שדות לעדכון (כולם ריקים/חובה)' });
            continue;
          }
          await supabase.updateById(table, row.dbId, patch);
          summary.updated++;
          summary.results.push({ key: row.key, op: 'update', side: 'db', name: row.name, dbId: row.dbId });
        }
      } else if (row.writeSide === 'monday') {
        // Full DB row for enrichment (composed title, relations, derived cols).
        const enrich = hasPushConfig(target.entity_type) && row.dbId
          ? await fetchDbRow(supabase, table, row.dbId, enrichCache)
          : null;
        if (row.op === 'create') {
          if (!allowCreate) { summary.skipped++; continue; }
          // The row looks unlinked, but the link table may already hold an item
          // for it (a write-back that failed, or a real-time push that created it
          // while this batch was running). Repair the link instead of creating a
          // twin — the next diff then sees a linked row and updates it.
          const already = await findLinkedItem({
            supabase, monday, target, entityType: target.entity_type, dbId: row.dbId, boardId,
          });
          if (already) {
            await supabase.updateById(table, row.dbId, {
              monday_board_id: String(boardId), monday_item_id: already,
            }).catch(() => {});
            summary.skipped++;
            summary.results.push({ key: row.key, op: 'create', side: 'monday', name: row.name,
              skipped: `הרשומה כבר מקושרת לפריט ${already} — הקישור תוקן במקום יצירת כפילות`, mondayItemId: already });
            continue;
          }
          const colVals = {};
          for (const ch of row.changes) {
            if (ch.mondayColumnId === 'name') continue; // composed title, not the business key
            const f = formatForMonday(ch.to, monTypes[ch.mondayColumnId]);
            if (f !== undefined) colVals[ch.mondayColumnId] = f;
          }
          let itemName = String(row.name || 'ללא שם');
          if (enrich) {
            const enr = await enrichPush({ supabase, target, dbRow: enrich, mode: 'create', cache: enrichCache, boardByEntity });
            Object.assign(colVals, enr.colVals);
            if (enr.title) itemName = enr.title;
          }
          const created = await monday.createItem(boardId, target.monday_group_id, itemName, colVals);
          // write the new link back to the DB row
          if (row.dbId && created?.id) {
            await supabase.updateById(table, row.dbId, {
              monday_board_id: String(boardId), monday_item_id: String(created.id),
            }).catch(() => {});
          }
          summary.created++;
          summary.results.push({ key: row.key, op: 'create', side: 'monday', name: itemName, mondayItemId: created?.id });
        } else {
          if (!allowUpdate) { summary.skipped++; continue; }
          const colVals = {};
          for (const ch of row.changes) {
            // Never overwrite the composed title with the business key on update
            // (composed-title entities only; salesperson name keeps syncing).
            if (ch.mondayColumnId === 'name' && hasComposedTitle(target.entity_type)) continue;
            const f = formatForMonday(ch.to, monTypes[ch.mondayColumnId]);
            if (f !== undefined) colVals[ch.mondayColumnId] = f;
          }
          if (enrich) {
            const item = await monday.getItem(row.mondayItemId).catch(() => null);
            const enr = await enrichPush({ supabase, target, dbRow: enrich, mode: 'update', item, cache: enrichCache, boardByEntity });
            Object.assign(colVals, enr.colVals);
          }
          if (Object.keys(colVals).length === 0) {
            summary.skipped++;
            summary.results.push({ key: row.key, op: 'update', side: 'monday', name: row.name, skipped: 'אין שינויים לדחיפה' });
            continue;
          }
          await monday.changeColumnValues(boardId, row.mondayItemId, colVals);
          summary.updated++;
          summary.results.push({ key: row.key, op: 'update', side: 'monday', name: row.name, mondayItemId: row.mondayItemId });
        }
      }
    } catch (e) {
      const msg = e.message || '';
      // Structural violations are expected, not real failures → skip, don't fail:
      //   • not-null / foreign key   — relational children (e.g. credits need a deal)
      //   • unique / duplicate key   — the row already exists in the DB under a
      //     different (or missing) Monday link and can't be auto-aligned
      //     (e.g. payments with a non-unique amount+customer key); the data is
      //     already present, only the Monday↔DB link is absent.
      // Everything else is a real failure.
      if (/not-null constraint|foreign key constraint|unique constraint|duplicate key/i.test(msg)) {
        summary.skipped++;
        summary.results.push({ key: row.key, op: row.op, side: row.writeSide, name: row.name, skipped: msg });
      } else {
        summary.failed++;
        summary.results.push({ key: row.key, op: row.op, side: row.writeSide, name: row.name, error: msg });
        // Log real failures so a scheduled/background run leaves a trace of WHICH
        // record failed and why (the counts alone are undiagnosable).
        console.error(`[apply] FAILED ${target.target_key} ${row.op} key=${row.key} name=${row.name || ''}: ${msg}`);
      }
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

// Fetch a full DB row by id (for push enrichment), memoized per apply run.
async function fetchDbRow(supabase, table, id, cache) {
  const key = `${table}:${id}`;
  if (cache && cache.has(key)) return cache.get(key);
  const rows = await supabase.select(table, { filters: [`id=eq.${id}`], limit: 1 }).catch(() => []);
  const row = rows[0] || null;
  if (cache) cache.set(key, row);
  return row;
}

// ── coercion helpers ────────────────────────────────────────
export function coerceForDb(text, pgType) {
  if (text === null || text === undefined || text === '') return null;
  const t = (pgType || '').toLowerCase();
  if (/int|numeric|double|real|decimal|number|float/.test(t)) {
    const n = Number(String(text).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (/bool/.test(t)) return /^(true|yes|1|v|✓|כן)$/i.test(String(text).trim());
  if (/date/.test(t) && !/timestamp/.test(t)) {
    const m = String(text).match(/\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : null;
  }
  if (/timestamp/.test(t)) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return String(text);
}

export function formatForMonday(value, colType) {
  // Safety: never push an empty value — reverse sync SETS/updates values but
  // does not CLEAR Monday fields (avoids accidental data loss on Monday).
  if (value === null || value === undefined || String(value).trim() === '') return undefined;
  const v = String(value);
  switch (colType) {
    case 'name':
    case 'text':
    case 'long_text':
    case 'long-text':
      return v;
    case 'numbers':
    case 'numeric':
      return v.replace(/,/g, '');
    case 'date': {
      const m = v.match(/\d{4}-\d{2}-\d{2}/);
      return m ? { date: m[0] } : '';
    }
    case 'status':
    case 'color':
      return { label: v };
    case 'dropdown':
      return { labels: v.split(',').map((s) => s.trim()).filter(Boolean) };
    case 'phone': {
      // Monday's phone column accepts digits only — strip dashes/spaces/etc.
      const digits = v.replace(/\D/g, '');
      return digits ? { phone: digits, countryShortName: 'IL' } : undefined;
    }
    case 'email':
      return { email: v, text: v };
    case 'link':
      return { url: v, text: v };
    default:
      return v; // best-effort for unmapped types
  }
}
