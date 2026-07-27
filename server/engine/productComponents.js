// Special sync for the product<->component junction board ("רכיבים במוצר").
// Its identity is NOT a name but the pair of board-relations (which product +
// which component). The generic engine can't resolve relations, so this module
// resolves each relation to a DB FK via the already-aligned parent tables
// (products / components, matched by monday_item_id), then upserts the junction
// row keyed by (product_id, component_id). Monday → DB only for now.

const PC_BOARD = '5100631747';
const PROD_BOARD = '5100631748';
const COMP_BOARD = '5100631743';
const REL_PROD = 'board_relation_mm50cxjm'; // "מוצרים"
const REL_COMP = 'board_relation_mm50hagj'; // "רכיב"
const QTY = 'numeric_mm50ve5f';             // -> default_quantity
const SORT = 'numeric_mm50zfnx';            // -> sort_order

// A board-relation column returns text=value=null via the generic query; its
// linked ids are only exposed through the typed BoardRelationValue fragment.
function firstLinkedId(col) {
  if (col && Array.isArray(col.linked_item_ids) && col.linked_item_ids.length) return String(col.linked_item_ids[0]);
  return null;
}
function numOrNull(col) {
  if (!col || col.text == null || col.text === '') return null;
  const n = Number(String(col.text).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export async function syncProductComponentFromMonday({ supabase, monday, itemId }) {
  // Dedicated query — relations need the BoardRelationValue fragment (getItem's
  // generic column_values returns null for board_relation).
  const data = await monday.execute(
    `query($id:[ID!]){ items(ids:$id){ id column_values(ids:["${REL_PROD}","${REL_COMP}","${QTY}","${SORT}"]){ id text ... on BoardRelationValue{ linked_item_ids } } } }`,
    { id: [String(itemId)] },
  );
  const it = data && data.items && data.items[0];
  if (!it) return { status: 'skipped', reason: 'monday item not found' };
  const cols = {};
  for (const c of it.column_values) cols[c.id] = c;

  const pItem = firstLinkedId(cols[REL_PROD]);
  const cItem = firstLinkedId(cols[REL_COMP]);
  if (!pItem || !cItem) return { status: 'skipped', reason: 'relation empty (product/component)' };

  const [prod, comp] = await Promise.all([
    supabase.select('products', { columns: 'id', filters: [`monday_item_id=eq.${pItem}`, `monday_board_id=eq.${PROD_BOARD}`, 'deleted_at=is.null'], limit: 1 }),
    supabase.select('components', { columns: 'id', filters: [`monday_item_id=eq.${cItem}`, `monday_board_id=eq.${COMP_BOARD}`, 'deleted_at=is.null'], limit: 1 }),
  ]);
  if (!prod[0]) return { status: 'skipped', reason: `product not aligned (monday item ${pItem})` };
  if (!comp[0]) return { status: 'skipped', reason: `component not aligned (monday item ${cItem})` };
  const product_id = prod[0].id;
  const component_id = comp[0].id;

  const patch = {
    default_quantity: numOrNull(cols[QTY]),
    sort_order: numOrNull(cols[SORT]),
    monday_board_id: String(PC_BOARD),
    monday_item_id: String(itemId),
  };

  // Prefer a row already linked to THIS item; else the (product,component) pair; else create.
  let rows = await supabase.select('product_components', { columns: 'id', filters: [`monday_item_id=eq.${itemId}`, 'deleted_at=is.null'], limit: 1 });
  let dbRow = rows[0];
  if (!dbRow) {
    rows = await supabase.select('product_components', { columns: 'id', filters: [`product_id=eq.${product_id}`, `component_id=eq.${component_id}`, 'deleted_at=is.null'], order: 'created_at', limit: 1 });
    dbRow = rows[0];
  }

  if (dbRow) {
    await supabase.updateById('product_components', dbRow.id, patch);
    return { status: 'ok', op: 'update', side: 'db', entity: 'deal_product', dbId: dbRow.id, itemId };
  }
  try {
    const created = await supabase.insert('product_components', [{ product_id, component_id, ...patch }]);
    return { status: 'ok', op: 'create', side: 'db', entity: 'deal_product', dbId: created && created[0] && created[0].id, itemId };
  } catch (e) {
    return { status: 'skipped', reason: 'create failed: ' + e.message };
  }
}
