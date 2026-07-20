// Pure, no-DB self-test for loopGuard. Simulates the 4-step echo loop and
// asserts that (a) a genuine change propagates exactly once and (b) the echo
// it triggers on the far side is suppressed, so the loop terminates.
//
// Run: node server/engine/loopGuard.test.mjs

import assert from 'node:assert';
import { contentHash, isEcho } from './loopGuard.js';

const fields = [
  { monday_column_id: 'name', source_field: 'name' },
  { monday_column_id: 'phone_1', source_field: 'phone' },
  { monday_column_id: 'status_x', source_field: 'customer_type' },
];

// A fake in-memory link holding the two stored hashes.
let link = { last_monday_hash: null, last_supabase_hash: null };
const record = (mondayHash, supabaseHash, source) => {
  link = { ...link, last_monday_hash: mondayHash, last_supabase_hash: supabaseHash, last_source: source };
};

// Side states (raw values as each side represents them).
const monday = { name: 'עסק א', phone_1: '050-1234567', status_x: 'פעיל' };
const db = { name: 'עסק א', phone: '0501234567', customer_type: 'active' };

const hashMonday = () => contentHash(fields, (f) => monday[f.monday_column_id]);
const hashDb = () => contentHash(fields, (f) => db[f.source_field]);

let mondayWrites = 0, dbWrites = 0;

// Simulate: an inbound event on `side`. Returns 'processed' | 'skipped-echo'.
function inbound(side) {
  const incoming = side === 'monday' ? hashMonday() : hashDb();
  if (isEcho(link, side, incoming)) return 'skipped-echo';
  // genuine change → write the OTHER side, then record both sides in sync.
  if (side === 'monday') { db.phone = '0501234567'; db.customer_type = 'active'; dbWrites++; }
  else { monday.phone_1 = '050-1234567'; monday.status_x = 'פעיל'; mondayWrites++; }
  record(hashMonday(), hashDb(), side);
  return 'processed';
}

// ── Scenario: user edits the Monday item (genuine change) ──────────────
// Start already in sync so we can prove the FIRST edit is genuine, not first-touch.
record(hashMonday(), hashDb(), 'init');
monday.status_x = 'מושהה';                    // user changes status on Monday
db.customer_type = 'active';                   // (db still old)

// Step 1: Monday webhook fires → should PROCESS and write DB once.
assert.equal(inbound('monday'), 'processed', 'genuine Monday edit must process');
assert.equal(dbWrites, 1, 'exactly one DB write');

// Step 2: that DB write fires the Supabase webhook → must be SUPPRESSED.
assert.equal(inbound('supabase'), 'skipped-echo', 'DB echo of our own write must be suppressed');
assert.equal(mondayWrites, 0, 'no Monday write from the echo → loop stops');

// ── Scenario: user edits the DB (genuine change, other direction) ──────
db.name = 'עסק ב';
assert.equal(inbound('supabase'), 'processed', 'genuine DB edit must process');
assert.equal(mondayWrites, 1, 'exactly one Monday write');
assert.equal(inbound('monday'), 'skipped-echo', 'Monday echo must be suppressed');
assert.equal(dbWrites, 1, 'no extra DB write → loop stops');

// ── Scenario: re-inbound with no change at all → echo (no-op) ──────────
assert.equal(inbound('monday'), 'skipped-echo', 'no-change re-check is an echo');
assert.equal(inbound('supabase'), 'skipped-echo', 'no-change re-check is an echo');

// ── Scenario: first-touch (no prior hash) must NOT be suppressed ───────
assert.equal(isEcho(null, 'monday', hashMonday()), false, 'unknown item is never an echo');
assert.equal(isEcho({ last_monday_hash: null }, 'monday', hashMonday()), false, 'null hash is never an echo');

console.log('✓ loopGuard: genuine changes propagate once, echoes suppressed, loop terminates');
console.log(`  final: dbWrites=${dbWrites} mondayWrites=${mondayWrites}`);
