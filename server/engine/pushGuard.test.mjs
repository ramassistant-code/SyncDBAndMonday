// Pure, no-network self-test for the duplicate-create guard.
//
// Reproduces the production failure (two overlapping cascades of one deal, each
// pushing the same credit) against a fake store, and asserts the guard turns the
// second push into an UPDATE instead of a second Monday item.
//
// Run: node server/engine/pushGuard.test.mjs

import assert from 'node:assert';
import { findLinkedItem, withRecordLock } from './pushGuard.js';

// ── a fake "credit" record + the push that syncs it ───────────────────
let store, created, sleepMs;

// The real push shape: read row → (slow enrichment) → create → write link back.
async function push(label) {
  const row = { ...store.credit };                       // read
  await sleep(sleepMs);                                  // enrichPush: seconds of joins
  if (row.monday_item_id) return { op: 'update', item: row.monday_item_id };
  const item = `item-${++created}`;                      // create_item
  store.credit.monday_item_id = item;                    // write-back
  return { op: 'create', item, label };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) WITHOUT the lock: two overlapping pushes both create → the prod bug.
store = { credit: { id: 'c1', monday_item_id: null } }; created = 0; sleepMs = 30;
let out = await Promise.all([push('a'), push('b')]);
assert.strictEqual(created, 2, 'baseline: unguarded overlap must duplicate');
assert.deepStrictEqual(out.map((o) => o.op), ['create', 'create']);

// 2) WITH the lock: the loser re-reads the row and updates the same item.
store = { credit: { id: 'c1', monday_item_id: null } }; created = 0;
const key = 'production:credit:c1';
out = await Promise.all([
  withRecordLock(key, () => push('a')),
  withRecordLock(key, () => push('b')),
]);
assert.strictEqual(created, 1, 'guarded overlap must create exactly one item');
assert.deepStrictEqual(out.map((o) => o.op), ['create', 'update']);
assert.strictEqual(out[1].item, out[0].item, 'the second push must land on the first item');

// 3) A failing push must not wedge the queue for that record.
store = { credit: { id: 'c2', monday_item_id: null } }; created = 0;
const k2 = 'production:credit:c2';
const boom = withRecordLock(k2, async () => { throw new Error('monday 500'); });
await assert.rejects(boom, /monday 500/);
const after = await withRecordLock(k2, () => push('c'));
assert.strictEqual(after.op, 'create', 'the next push still runs after a failure');

// 4) Different records are not serialised against each other.
store = { credit: { id: 'c3', monday_item_id: null } }; created = 0;
const t0 = Date.now();
await Promise.all([
  withRecordLock('production:credit:x', () => sleep(40)),
  withRecordLock('production:credit:y', () => sleep(40)),
]);
assert.ok(Date.now() - t0 < 75, 'independent records must still run in parallel');

// ── findLinkedItem: the cross-process / failed-write-back layer ────────
const target = { id: 'tgt-1' };
const linkRow = { monday_item_id: '900', monday_board_id: '2091986228' };
const fakeSupabase = (rows) => ({ select: async () => rows });
const fakeMonday = (exists) => ({ getItem: async (id) => (exists ? { id } : null) });

assert.strictEqual(
  await findLinkedItem({ supabase: fakeSupabase([linkRow]), monday: fakeMonday(true), target, entityType: 'credit', dbId: 'c1', boardId: '2091986228' }),
  '900', 'a live linked item is adopted instead of creating a twin');

assert.strictEqual(
  await findLinkedItem({ supabase: fakeSupabase([linkRow]), monday: fakeMonday(false), target, entityType: 'credit', dbId: 'c1', boardId: '2091986228' }),
  null, 'an item deleted from the board must not be adopted');

assert.strictEqual(
  await findLinkedItem({ supabase: fakeSupabase([linkRow]), monday: fakeMonday(true), target, entityType: 'credit', dbId: 'c1', boardId: '111' }),
  null, "another environment's link must be ignored");

assert.strictEqual(
  await findLinkedItem({ supabase: fakeSupabase([]), monday: fakeMonday(true), target, entityType: 'credit', dbId: 'c1', boardId: '2091986228' }),
  null, 'no link row → create is allowed');

console.log('pushGuard: all assertions passed ✅');
