// Duplicate-customer merge tool. CONSERVATIVE by design:
// only rows sharing BOTH normalized phone AND normalized name are merged
// (same phone + different name = different people → left for manual review).
//
// Merge = re-point every FK reference from the duplicate to the survivor,
// then delete the duplicate. Survivor = earliest created_at (the original seed).

import { normalizePhone, normalizeName } from './compare.js';

// Per-entity dedup config: the base table + every FK column that references it
// (must be re-pointed to the survivor before deleting a duplicate).
export const ENTITY_DEDUP = {
  customers: {
    table: 'customers',
    refs: [
      { table: 'deals', col: 'customer_id' },
      { table: 'payments', col: 'customer_id' },
      { table: 'credits', col: 'customer_id' },
      { table: 'quotes', col: 'customer_id' },
      { table: 'special_tasks', col: 'customer_id' },
      { table: 'leads', col: 'linked_customer_id' },
    ],
  },
  leads: {
    table: 'leads',
    refs: [
      { table: 'customers', col: 'lead_id' },
      { table: 'deals', col: 'lead_id' },
      { table: 'quotes', col: 'lead_id' },
      { table: 'special_tasks', col: 'lead_id' },
    ],
  },
};

function cfgFor(entity) {
  const cfg = ENTITY_DEDUP[entity];
  if (!cfg) { const e = new Error(`No dedup config for entity "${entity}"`); e.status = 422; throw e; }
  return cfg;
}

async function loadRows(supabase, table) {
  const schema = await supabase.introspect();
  const cols = new Set((schema[table] || []).map((c) => c.name));
  const want = ['id', 'name', 'phone', 'email', 'monday_board_id', 'monday_item_id', 'created_at'];
  if (cols.has('normalized_phone')) want.push('normalized_phone');
  const columns = want.filter((c) => cols.has(c)).join(',');
  return supabase.select(table, { columns, order: 'created_at' });
}

export async function buildDedup({ supabase, entity = 'customers' }) {
  const cfg = cfgFor(entity);
  const REFS = cfg.refs;
  const rows = await loadRows(supabase, cfg.table);

  // group by phone, then by name → merge units of >1 same-name rows
  const byPhone = new Map();
  for (const r of rows) {
    const p = normalizePhone(r.normalized_phone || r.phone);
    if (!p) continue;
    if (!byPhone.has(p)) byPhone.set(p, []);
    byPhone.get(p).push(r);
  }

  const mergeGroups = [];
  const reviewGroups = [];
  const allDupIds = [];

  for (const [phone, grp] of byPhone) {
    if (grp.length < 2) continue;
    const byName = new Map();
    for (const r of grp) {
      const n = normalizeName(r.name);
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(r);
    }
    // confident merge units: same name appears more than once
    for (const [name, rs] of byName) {
      if (rs.length < 2) continue;
      const sorted = [...rs].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const survivor = sorted[0];
      const dups = sorted.slice(1);
      dups.forEach((d) => allDupIds.push(d.id));
      mergeGroups.push({
        key: 'merge:' + phone + ':' + name,
        phone, name,
        survivor: { id: survivor.id, name: survivor.name, board: survivor.monday_board_id, created_at: survivor.created_at },
        duplicates: dups.map((d) => ({ id: d.id, name: d.name, board: d.monday_board_id, created_at: d.created_at })),
      });
    }
    // ambiguous: more than one distinct name on the same phone
    if (byName.size > 1) {
      reviewGroups.push({
        key: 'review:' + phone,
        phone,
        rows: grp.map((r) => ({ id: r.id, name: r.name, board: r.monday_board_id })),
      });
    }
  }

  // Count FK references for all duplicate ids (batched per table).
  const refCounts = new Map(); // dupId -> { table: count }
  for (const id of allDupIds) refCounts.set(id, {});
  for (const ref of REFS) {
    const found = await supabase.selectIn(ref.table, ref.col, allDupIds, ref.col);
    for (const row of found) {
      const id = row[ref.col];
      const bucket = refCounts.get(id);
      if (bucket) bucket[ref.table] = (bucket[ref.table] || 0) + 1;
    }
  }
  for (const g of mergeGroups) {
    for (const d of g.duplicates) d.refs = refCounts.get(d.id) || {};
    g.totalRefs = g.duplicates.reduce((s, d) => s + Object.values(d.refs).reduce((a, b) => a + b, 0), 0);
  }

  return {
    entity,
    counts: {
      mergeGroups: mergeGroups.length,
      rowsMerged: allDupIds.length,
      reviewGroups: reviewGroups.length,
    },
    totals: { rows: rows.length },
    groups: mergeGroups,
    reviewGroups,
  };
}

export async function applyDedup({ supabase, entity = 'customers', selectedKeys }) {
  const cfg = cfgFor(entity);
  const plan = await buildDedup({ supabase, entity });
  const wanted = selectedKeys ? new Set(selectedKeys) : null;
  const groups = plan.groups.filter((g) => (wanted ? wanted.has(g.key) : true));

  const summary = { entity, requested: groups.length, merged: 0, deleted: 0, repointed: 0, failed: 0, results: [], startedAt: new Date().toISOString() };
  for (const g of groups) {
    try {
      for (const dup of g.duplicates) {
        // 1) re-point all references to the survivor
        for (const ref of cfg.refs) {
          const changed = await supabase.updateWhere(ref.table, ref.col, dup.id, { [ref.col]: g.survivor.id });
          summary.repointed += changed.length;
        }
        // 2) delete the duplicate row
        await supabase.deleteWhere(cfg.table, 'id', dup.id);
        summary.deleted++;
      }
      summary.merged++;
      summary.results.push({ key: g.key, survivor: g.survivor.name, mergedIds: g.duplicates.map((d) => d.id) });
    } catch (e) {
      summary.failed++;
      summary.results.push({ key: g.key, survivor: g.survivor.name, error: e.message });
    }
  }
  summary.finishedAt = new Date().toISOString();
  return summary;
}
