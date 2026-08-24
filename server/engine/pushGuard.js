// Guards the DB→Monday CREATE path against creating the same record twice.
//
// A push is a check-then-create: read the DB row, see it has no monday_item_id,
// build the enriched payload (for a credit that is several DB round-trips —
// customer, deal, quote_products, quote_components — plus Monday reads, i.e.
// seconds), create the item, write the new id back to the row. Two pushes of the
// same record that overlap in that window both pass the check and both create.
// The record then has two Monday items: the second write-back wins, the first
// item is orphaned on the board and stops receiving updates.
//
// Overlapping pushes are normal, not exotic: the app calls /api/push
// {deal_created} while the Supabase webhook on `deals` cascades the same deal,
// n8n retries a timed-out call, a user saves twice. Production proved it —
// deal 3182946727 (24/08, 15:47) got 3 of its 4 credits duplicated, each pair
// created 2 seconds apart with the same composed title.
//
// Two layers:
//   1. withRecordLock — serialises pushes of the SAME record inside this process.
//      The loser re-reads the row after the winner wrote the link back, sees the
//      item id and takes the update path.
//   2. findLinkedItem — right before creating, ask monday_entity_links (UNIQUE
//      on target+entity_type+source_record_id) whether this record already owns
//      an item. Catches a row whose write-back failed, and narrows the window if
//      the service is ever scaled past one instance.

const LINK_TABLE = 'monday_entity_links';

// key → promise of the last queued push for that key.
const locks = new Map();

// Run `fn` only after any push already queued for `key` has settled.
export function withRecordLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);              // a failed predecessor must not block the queue
  const tail = run.then(() => {}, () => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

// The Monday item this DB record already owns on `boardId`, or null.
// Reads the link table (which the push writes on every successful sync) rather
// than the record's own monday_item_id, so a failed write-back doesn't cause a
// second item. Returns null when the item no longer exists on the board — then
// creating a fresh one is the right move.
export async function findLinkedItem({ supabase, monday, target, entityType, dbId, boardId }) {
  if (!target?.id || !dbId) return null;
  const rows = await supabase.select(LINK_TABLE, {
    columns: 'monday_item_id,monday_board_id',
    filters: [
      `target_id=eq.${target.id}`,
      `entity_type=eq.${entityType}`,
      `source_record_id=eq.${dbId}`,
    ],
    limit: 1,
  }).catch(() => []);
  const link = rows[0];
  if (!link || !link.monday_item_id) return null;
  if (String(link.monday_board_id) !== String(boardId)) return null; // other environment's board
  const item = await monday.getItem(link.monday_item_id).catch(() => null);
  return item ? String(link.monday_item_id) : null;
}
