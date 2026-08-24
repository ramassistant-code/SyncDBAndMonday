// Loop / echo suppression for real-time bidirectional sync.
//
// The problem: a real-time write on one side triggers that side's webhook,
// which would push back to the origin side, which fires its webhook, ... forever.
//
// The diff engine already gives *natural* damping (an echo re-diffs to a no-op),
// but only if normalization is perfectly symmetric across a round-trip. Phone /
// status / number / date formatting are not, so an echo can look like a real
// change and ping-pong. This module is the definitive guard: after a two-sided
// sync we remember each side's content hash in `monday_entity_links`; an inbound
// event whose current hash equals the hash WE last wrote for that side is an
// echo and is skipped.
//
// Identity follows the control-plane: (environment, entity_type, monday_board_id,
// monday_item_id), stored as idempotency_key = `${entity}-${board}-${item}`.
// Nothing else in the engine touches monday_entity_links, so this owns it.

import crypto from 'node:crypto';
import { norm } from './compare.js';

const LINK_TABLE = 'monday_entity_links';

export function idemKey(entityType, boardId, itemId) {
  return `${entityType}-${boardId}-${itemId}`;
}

// Canonical content hash of a mapped tuple from ONE side's point of view.
// fields: [{ monday_column_id, source_field }]; getValue(field) returns that
// side's raw value. Keyed by monday_column_id so both sides align on the same
// key set, and order-independent so field ordering can't change the hash.
export function contentHash(fields, getValue) {
  const pairs = fields
    .map((f) => [f.monday_column_id, norm(getValue(f))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

// Canonical hash of the ENRICHED values a push resolves (board_relation links,
// derived joins, computed columns) — see enrich.js `fingerprint`.
//
// These live OUTSIDE the mapped-field tuple that contentHash() covers: they are
// read from joined tables (a credit's note comes from quote_components, a
// payment's salesperson name from app_users), so a change to one leaves every
// mapped field untouched and contentHash identical. Without this second hash the
// echo guard reads such a push as "nothing changed" and skips it, and the new
// value never reaches Monday.
export function valuesHash(values) {
  const pairs = Object.entries(values || {})
    .map(([k, v]) => [k, v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : norm(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

// Are the enriched values unchanged since our last write? Mirrors isEcho: with no
// stored hash (a link written before this guard existed, or by the inbound path)
// the answer is false, so the first push after deploy goes through and backfills.
export function isEnrichEcho(link, incomingHash) {
  const stored = link && link.sync_state ? link.sync_state.enrich_hash : null;
  return Boolean(stored) && stored === incomingHash;
}

// Read the stored link (hashes + metadata) for one item, or null.
export async function getLink(supabase, { environment, entityType, boardId, itemId }) {
  const rows = await supabase.select(LINK_TABLE, {
    filters: [
      `idempotency_key=eq.${idemKey(entityType, boardId, itemId)}`,
      `environment=eq.${environment}`,
    ],
    limit: 1,
  });
  return rows[0] || null;
}

// Is an inbound change on `side` merely the echo of what we last wrote there?
// side: 'monday' | 'supabase'. Returns false when there is no prior hash (first
// time we see this item) so genuine first syncs are never suppressed.
export function isEcho(link, side, incomingHash) {
  if (!link) return false;
  const col = side === 'monday' ? 'last_monday_hash' : 'last_supabase_hash';
  return Boolean(link[col]) && link[col] === incomingHash;
}

// After a successful sync, record BOTH sides' hashes as the new in-sync state so
// the write we just made on the far side is recognised as an echo when it comes
// back. `source` records which side drove this sync ('monday' | 'supabase').
export async function recordSynced(supabase, {
  environment, entityType, boardId, itemId,
  targetId = null, sourceRecordId = null, source,
  mondayHash, supabaseHash, enrichHash = null, runId = null,
}) {
  const now = new Date().toISOString();
  const patch = {
    last_monday_hash: mondayHash,
    last_supabase_hash: supabaseHash,
    last_source: source,
    last_synced_at: now,
    updated_at: now,
    is_active: true,
  };
  if (runId) patch.last_run_id = runId;

  const existing = await getLink(supabase, { environment, entityType, boardId, itemId });
  // The enriched-values hash rides in the existing `sync_state` jsonb (no schema
  // change). Only the push path computes it; the inbound path passes null and
  // must leave whatever is stored alone.
  if (enrichHash) patch.sync_state = { ...(existing?.sync_state || {}), enrich_hash: enrichHash };
  if (existing) return supabase.updateById(LINK_TABLE, existing.id, patch);
  // `deal_id` is a NOT-NULL generic record-id column (legacy name); the seeded
  // rows set it equal to source_record_id, so we mirror that convention.
  const recordId = sourceRecordId == null ? null : String(sourceRecordId);

  // The record may already hold a link row pointing at a DIFFERENT item (its
  // Monday item was re-created, or a duplicate create beat us to it). The table
  // is UNIQUE(target_id, entity_type, source_record_id), so inserting a second
  // row throws and the whole sync is reported as failed — re-point the existing
  // row at the item we just synced instead.
  if (targetId && recordId) {
    const prior = await supabase.select(LINK_TABLE, {
      filters: [
        `target_id=eq.${targetId}`,
        `entity_type=eq.${entityType}`,
        `source_record_id=eq.${recordId}`,
      ],
      limit: 1,
    }).catch(() => []);
    if (prior[0]) {
      return supabase.updateById(LINK_TABLE, prior[0].id, {
        ...patch,
        monday_board_id: String(boardId),
        monday_item_id: String(itemId),
        idempotency_key: idemKey(entityType, boardId, itemId),
      });
    }
  }

  return supabase.insert(LINK_TABLE, [{
    idempotency_key: idemKey(entityType, boardId, itemId),
    environment,
    entity_type: entityType,
    monday_board_id: String(boardId),
    monday_item_id: String(itemId),
    target_id: targetId,
    source_record_id: recordId,
    deal_id: recordId,
    ...patch,
  }]);
}
