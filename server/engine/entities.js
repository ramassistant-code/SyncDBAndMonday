// Maps a control-plane entity_type to its Supabase base table.
// Derived from live introspection of the dev DB (19/07/2026).
export const ENTITY_TABLE = {
  customer: 'customers',
  lead: 'leads',
  deal: 'deals',
  payment: 'payments',
  credit: 'credits',
  product: 'products',
  component_operation: 'components',
  coordination_task: 'deal_coordination_tasks',
  special_task: 'special_tasks',
  salesperson: 'app_users',
  deal_product: 'product_components',
};

export function tableForTarget(target) {
  const t = ENTITY_TABLE[target.entity_type];
  if (!t) {
    const e = new Error(`No table mapping for entity_type "${target.entity_type}" (target ${target.target_key})`);
    e.status = 422;
    throw e;
  }
  return t;
}
