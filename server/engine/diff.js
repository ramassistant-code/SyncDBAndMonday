// Builds a diff between a Supabase table and a Monday board for one target,
// according to the target's field mappings and the chosen direction.
//
// direction: 'monday_to_db' | 'db_to_monday' | 'bidirectional'

import { getFieldMappings } from '../controlPlane.js';
import { tableForTarget, filtersForTarget } from './entities.js';
import { valuesEqual, norm } from './compare.js';
import { hasComposedTitle } from './enrich.js';

const NAME_COLUMN = 'name'; // Monday's built-in item title column id

export async function buildDiff({ supabase, monday, target, direction }) {
  const warnings = [];
  const boardId = target.monday_board_id;
  if (!boardId || boardId === 'CONFIGURE_BOARD_ID') {
    const e = new Error(`Target "${target.target_key}" has no valid monday_board_id`);
    e.status = 422; throw e;
  }

  const table = tableForTarget(target);
  const allMappings = (await getFieldMappings(supabase, target.id))
    .filter((m) => m.source_field && m.monday_column_id);
  // For entities whose Monday title is a COMPOSED, DB-owned name (deal/payment/
  // credit → "customer | date …"), the `name` column must never be diffed: the
  // composed title never equals the business number (deal_number/…), so every
  // linked row would churn as an update whose only change is `name`, which
  // apply.js then drops → counted as "skipped" (this is the 1712 skipped seen in
  // the scheduled sync). Excluding it here removes the churn AND stops a batch
  // inbound CREATE from writing the composed title into the business-number
  // field (same class of bug as commit e455820 fixed for the real-time path).
  const mappings = hasComposedTitle(target.entity_type)
    ? allMappings.filter((m) => m.monday_column_id !== NAME_COLUMN)
    : allMappings;

  // The DB column that maps to Monday's title, used for names on create/display.
  // Resolve from the FULL mapping set (allMappings) — even when the composed-title
  // filter above drops `name` from the diff, we still need its DB field
  // (deal_number/…) to fetch the column and label rows.
  const nameMap = allMappings.find((m) => m.monday_column_id === NAME_COLUMN);
  const nameField = nameMap ? nameMap.source_field : 'name';

  // Columns we need from the DB.
  const dbColumns = Array.from(new Set([
    'id', 'monday_board_id', 'monday_item_id', 'monday_group_id',
    nameField, ...mappings.map((m) => m.source_field),
  ])).join(',');

  const [dbRows, mondayItems, boardMeta] = await Promise.all([
    supabase.select(table, { columns: dbColumns, filters: ['deleted_at=is.null', ...filtersForTarget(target)], order: 'created_at' }).catch(async (e) => {
      // some tables have no deleted_at
      if (/deleted_at/.test(e.message)) return supabase.select(table, { columns: dbColumns, filters: filtersForTarget(target) });
      throw e;
    }),
    monday.getItems(boardId),
    monday.getBoardMeta(boardId),
  ]);

  if (boardMeta && target.board_name_expected && boardMeta.name !== target.board_name_expected) {
    warnings.push(`שם הלוח בפועל ("${boardMeta.name}") שונה מהמצופה ("${target.board_name_expected}")`);
  }

  // Identity = Monday item id of THIS target's board. A DB row counts as
  // linked to this target only if its monday_board_id matches the target board
  // (the seeded rows point at the production board, so they are ignored here).
  const boardStr = String(boardId);
  const dbByItem = new Map();      // rows genuinely linked to this target
  const dbOtherEnv = [];           // rows linked to a different board (other env)
  const dbNullLink = [];           // rows never linked to Monday
  for (const r of dbRows) {
    if (r.monday_board_id && String(r.monday_board_id) === boardStr && r.monday_item_id) {
      dbByItem.set(String(r.monday_item_id), r);
    } else if (r.monday_board_id) {
      dbOtherEnv.push(r);
    } else {
      dbNullLink.push(r);
    }
  }
  const mondayById = new Map(mondayItems.map((i) => [String(i.id), i]));

  const rows = [];
  const counts = { create: 0, update: 0, unchanged: 0, conflict: 0, missing: 0, skippedOtherEnv: dbOtherEnv.length };

  const pull = direction === 'monday_to_db' || direction === 'bidirectional';
  const push = direction === 'db_to_monday' || direction === 'bidirectional';

  // 1) Walk Monday items → matched or new-to-DB
  for (const item of mondayItems) {
    const dbRow = dbByItem.get(String(item.id));
    if (!dbRow) {
      if (pull) {
        const changes = mappings.map((m) => ({
          field: m.source_field, mondayColumnId: m.monday_column_id,
          from: null, to: cellText(item, m.monday_column_id),
        }));
        rows.push({ key: 'mon:' + item.id, op: 'create', writeSide: 'db',
          mondayItemId: item.id, dbId: null, name: item.name, changes });
        counts.create++;
      }
      continue;
    }
    // matched pair → field-level compare
    const fieldDiffs = [];
    for (const m of mappings) {
      const mt = cellText(item, m.monday_column_id);
      const dv = dbRow[m.source_field];
      if (!valuesEqual(dv, mt)) {
        fieldDiffs.push({ field: m.source_field, mondayColumnId: m.monday_column_id,
          dbValue: norm(dv), mondayValue: norm(mt), authority: m.field_authority });
      }
    }
    if (fieldDiffs.length === 0) { counts.unchanged++; continue; }

    if (direction === 'monday_to_db') {
      rows.push(pairRow('update', 'db', item, dbRow, fieldDiffs.map((d) =>
        ({ field: d.field, mondayColumnId: d.mondayColumnId, from: d.dbValue, to: d.mondayValue }))));
      counts.update++;
    } else if (direction === 'db_to_monday') {
      rows.push(pairRow('update', 'monday', item, dbRow, fieldDiffs.map((d) =>
        ({ field: d.field, mondayColumnId: d.mondayColumnId, from: d.mondayValue, to: d.dbValue }))));
      counts.update++;
    } else {
      // bidirectional → resolve each field by authority
      const toDb = [], toMon = [];
      for (const d of fieldDiffs) {
        if (d.authority === 'supabase') toMon.push({ field: d.field, mondayColumnId: d.mondayColumnId, from: d.mondayValue, to: d.dbValue });
        else toDb.push({ field: d.field, mondayColumnId: d.mondayColumnId, from: d.dbValue, to: d.mondayValue });
      }
      if (toDb.length) { rows.push(pairRow('update', 'db', item, dbRow, toDb)); counts.update++; }
      if (toMon.length) { rows.push(pairRow('update', 'monday', item, dbRow, toMon)); counts.update++; }
    }
  }

  // 2) Target-linked DB rows whose Monday item no longer exists on the board.
  for (const [itemId, r] of dbByItem) {
    if (mondayById.has(itemId)) continue; // matched → already handled in loop 1
    rows.push({ key: 'db:' + r.id, op: 'missing', writeSide: null,
      dbId: r.id, mondayItemId: itemId, name: r[nameField], changes: [] });
    counts.missing++;
  }

  // 3) On push, DB rows never linked to Monday → create on the board.
  if (push) {
    for (const r of dbNullLink) {
      const changes = mappings
        .filter((m) => m.monday_column_id !== NAME_COLUMN)
        .map((m) => ({ field: m.source_field, mondayColumnId: m.monday_column_id, from: null, to: norm(r[m.source_field]) }));
      rows.push({ key: 'db:' + r.id, op: 'create', writeSide: 'monday',
        dbId: r.id, mondayItemId: null, name: r[nameField], changes });
      counts.create++;
    }
  }

  return {
    target: { key: target.target_key, name: target.target_name, entity_type: target.entity_type,
      table, board_id: boardId, board_name: boardMeta?.name || null },
    direction,
    fields: mappings.map((m) => ({ source_field: m.source_field, monday_column_id: m.monday_column_id,
      monday_column_name: m.monday_column_name, authority: m.field_authority })),
    warnings, counts,
    totals: { db: dbRows.length, monday: mondayItems.length,
      linkedToTarget: dbByItem.size, otherEnv: dbOtherEnv.length, nullLink: dbNullLink.length },
    rows,
  };
}

function cellText(item, colId) {
  if (colId === NAME_COLUMN) return item.name;
  const c = item.columns[colId];
  return c ? c.text : null;
}

function pairRow(op, writeSide, item, dbRow, changes) {
  return { key: 'mon:' + item.id, op, writeSide,
    mondayItemId: item.id, dbId: dbRow.id, name: item.name || dbRow.name, changes };
}
