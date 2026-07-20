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
  mondayHash, supabaseHash, runId = null,
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
  if (existing) return supabase.updateById(LINK_TABLE, existing.id, patch);
  // `deal_id` is a NOT-NULL generic record-id column (legacy name); the seeded
  // rows set it equal to source_record_id, so we mirror that convention.
  const recordId = sourceRecordId == null ? null : String(sourceRecordId);
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
