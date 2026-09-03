// Pure, no-network self-test for the coordination-task push/pull fixes:
//   • relation column ids differ dev↔prod for columns added after the clone —
//     the engine must pick the id for the TARGET's environment, never fall back
//   • the task item is titled "customer | task text", customer taken from the
//     task's deal (the row has no customer_id), and re-written when task_text changes
//   • a rename webhook strips exactly that prefix before it reaches task_text
//
// Run: node server/engine/coordTask.test.mjs

import assert from 'node:assert';
import {
  INBOUND_RELATIONS, PUSH_CONFIG,
  enrichPush, relationColumn, resolveInboundRelations, taskTextFromTitle,
} from './enrich.js';

// ── relationColumn: per-environment ids ───────────────────────────────
assert.strictEqual(relationColumn({ column: 'board_relation_x' }, 'production'), 'board_relation_x');
assert.strictEqual(relationColumn({ column: 'board_relation_x' }, null), 'board_relation_x');
assert.strictEqual(relationColumn({ column: { test: 'dev_col', production: 'prod_col' } }, 'test'), 'dev_col');
assert.strictEqual(relationColumn({ column: { test: 'dev_col', production: 'prod_col' } }, 'production'), 'prod_col');
assert.strictEqual(relationColumn({ column: { test: 'dev_col' } }, 'production'), null, 'no prod id → skip, never the dev id');
assert.strictEqual(relationColumn({ column: { test: 'dev_col', production: 'prod_col' } }, null), null);

// the live ids, as verified 2026-09-03 with prod_bootstrap/probe_relation_columns.mjs
const taskRel = PUSH_CONFIG.coordination_task.relations.find((r) => r.fk === 'deal_id');
assert.strictEqual(relationColumn(taskRel, 'test'), 'board_relation_mm5jv7cn');
assert.strictEqual(relationColumn(taskRel, 'production'), 'board_relation_mm5jveeq');
const paySp = PUSH_CONFIG.payment.relations.find((r) => r.fk === 'salesperson_id');
assert.strictEqual(relationColumn(paySp, 'test'), 'board_relation_mm5js0ns');
assert.strictEqual(relationColumn(paySp, 'production'), 'board_relation_mm5jmf0w');
// inbound mirrors outbound, per environment
for (const env of ['test', 'production']) {
  assert.strictEqual(relationColumn(INBOUND_RELATIONS.coordination_task.find((r) => r.fk === 'deal_id'), env), relationColumn(taskRel, env));
  assert.strictEqual(relationColumn(INBOUND_RELATIONS.payment.find((r) => r.fk === 'salesperson_id'), env), relationColumn(paySp, env));
}

// ── a fake DB: deals / customers / tasks by id ────────────────────────
const DB = {
  deals: [{ id: 'deal-1', customer_id: 'cust-1', monday_item_id: '3196272685', monday_board_id: '2091985867' },
          { id: 'deal-nocust', customer_id: null, monday_item_id: '999', monday_board_id: '2091985867' }],
  customers: [{ id: 'cust-1', name: 'שמעון אופיר' }],
};
const supabase = {
  select: async (table, { filters = [] } = {}) => {
    const idF = filters.find((f) => f.startsWith('id=eq.'));
    const rows = DB[table] || [];
    return idF ? rows.filter((r) => r.id === idF.slice('id=eq.'.length)) : rows;
  },
};
const boardByEntity = { deal: '2091985867', coordination_task: '5099906521' };
const prodTarget = { entity_type: 'coordination_task', environment: 'production' };
const devTarget = { entity_type: 'coordination_task', environment: 'test' };
const task = { id: 't1', deal_id: 'deal-1', task_text: 'לאחר צילום - הערות בוואצפ' };

// ── create: composed title via the deal's customer + prod link column ─
{
  const enr = await enrichPush({ supabase, target: prodTarget, dbRow: task, mode: 'create', boardByEntity });
  assert.strictEqual(enr.title, 'שמעון אופיר | לאחר צילום - הערות בוואצפ');
  assert.deepStrictEqual(enr.colVals, { board_relation_mm5jveeq: { item_ids: [3196272685] } }, 'prod must write the prod column');
  assert.ok(!('board_relation_mm5jv7cn' in enr.colVals), 'the dev column id must not leak into prod');
}
{
  const enr = await enrichPush({ supabase, target: devTarget, dbRow: task, mode: 'create', boardByEntity });
  assert.deepStrictEqual(Object.keys(enr.colVals), ['board_relation_mm5jv7cn'], 'dev keeps the dev column');
}
// no customer on the deal → title degrades to the task text alone
{
  const enr = await enrichPush({ supabase, target: prodTarget, dbRow: { ...task, deal_id: 'deal-nocust' }, mode: 'create', boardByEntity });
  assert.strictEqual(enr.title, 'לאחר צילום - הערות בוואצפ');
}

// ── update: title re-written only when it drifted; link backfilled ────
const itemUnlinked = { name: 'לאחר צילום - הערות בוואצפ', columns: { board_relation_mm5jveeq: { text: null, value: null, linkedIds: [] } } };
{
  const enr = await enrichPush({ supabase, target: prodTarget, dbRow: task, mode: 'update', item: itemUnlinked, boardByEntity });
  assert.strictEqual(enr.title, 'שמעון אופיר | לאחר צילום - הערות בוואצפ', 'a plain title (pre-fix item) gets the composed one');
  assert.deepStrictEqual(enr.colVals, { board_relation_mm5jveeq: { item_ids: [3196272685] } }, 'missing link is backfilled');
  assert.strictEqual(enr.fingerprint.name, 'שמעון אופיר | לאחר צילום - הערות בוואצפ', 'title joins the echo fingerprint');
}
const itemInSync = { name: 'שמעון אופיר | לאחר צילום - הערות בוואצפ', columns: { board_relation_mm5jveeq: { text: null, value: null, linkedIds: [3196272685] } } };
{
  const enr = await enrichPush({ supabase, target: prodTarget, dbRow: task, mode: 'update', item: itemInSync, boardByEntity });
  assert.strictEqual(enr.title, null, 'nothing to rename');
  assert.deepStrictEqual(enr.colVals, {}, 'nothing to write → no churn');
}
{
  const enr = await enrichPush({ supabase, target: prodTarget, dbRow: { ...task, task_text: 'לאחר צילום' }, mode: 'update', item: itemInSync, boardByEntity });
  assert.strictEqual(enr.title, 'שמעון אופיר | לאחר צילום', 'an edited task_text renames the item');
}
// the date-stamped titles stay create-only
{
  const enr = await enrichPush({ supabase, target: { entity_type: 'payment', environment: 'production' },
    dbRow: { id: 'p1', customer_id: 'cust-1', created_at: '2026-08-31T12:09:07Z' }, mode: 'update', item: { name: 'whatever', columns: {} }, boardByEntity });
  assert.strictEqual(enr.title, null);
  assert.ok(!('name' in enr.fingerprint));
}

// ── inbound: the prod link column resolves the deal ───────────────────
{
  const item = { columns: { board_relation_mm5jveeq: { text: null, value: null, linkedIds: ['3196272685'] } } };
  const sb = { select: async () => [{ id: 'deal-1' }] };
  assert.deepStrictEqual(await resolveInboundRelations({ supabase: sb, entityType: 'coordination_task', item, boardByEntity, environment: 'production' }),
    { deal_id: 'deal-1' });
  assert.deepStrictEqual(await resolveInboundRelations({ supabase: sb, entityType: 'coordination_task', item, boardByEntity, environment: 'test' }),
    {}, 'dev reads its own column, which this item does not carry');
}

// ── inbound: title → task text ────────────────────────────────────────
assert.strictEqual(await taskTextFromTitle({ supabase, title: 'שמעון אופיר | לאחר צילום - הערות בוואצפ', dealId: 'deal-1' }), 'לאחר צילום - הערות בוואצפ');
assert.strictEqual(await taskTextFromTitle({ supabase, title: 'לאחר צילום', dealId: 'deal-1' }), 'לאחר צילום', 'no prefix → untouched');
assert.strictEqual(await taskTextFromTitle({ supabase, title: 'מישהו אחר | לאחר צילום', dealId: 'deal-1' }), 'מישהו אחר | לאחר צילום', 'another prefix is not ours → untouched');
assert.strictEqual(await taskTextFromTitle({ supabase, title: 'שמעון אופיר | ', dealId: 'deal-1' }), 'שמעון אופיר | ', 'empty remainder → keep the title');
assert.strictEqual(await taskTextFromTitle({ supabase, title: 'שמעון אופיר | x', dealId: null }), 'שמעון אופיר | x', 'no deal → cannot know the customer → untouched');
assert.strictEqual(await taskTextFromTitle({ supabase, title: 'שמעון אופיר | x', dealId: 'deal-nocust' }), 'שמעון אופיר | x');
assert.strictEqual(await taskTextFromTitle({ supabase, title: null, dealId: 'deal-1' }), null);
// round trip: push title → inbound parse → the original text
{
  const enr = await enrichPush({ supabase, target: prodTarget, dbRow: task, mode: 'create', boardByEntity });
  assert.strictEqual(await taskTextFromTitle({ supabase, title: enr.title, dealId: task.deal_id }), task.task_text);
}

console.log('coordination task (env column ids + composed title + inbound parse): all assertions passed ✅');
