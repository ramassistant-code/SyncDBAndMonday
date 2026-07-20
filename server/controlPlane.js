// Read access to the existing sync control-plane tables.
// These are the source of truth for what to sync and how.

export async function getTargets(supabase, controlPlaneEnv) {
  return supabase.select('monday_export_targets', {
    columns:
      'id,target_key,target_name,entity_type,source_type,source_query_key,monday_board_id,monday_group_id,' +
      'board_name_expected,environment,is_active,sync_order,inbound_enabled,outbound_enabled,' +
      'create_enabled,update_enabled,delete_enabled,skip_unchanged_enabled',
    filters: [`environment=eq.${controlPlaneEnv}`],
    order: 'sync_order,target_name',
  });
}

export async function getTargetByKey(supabase, controlPlaneEnv, targetKey) {
  const rows = await supabase.select('monday_export_targets', {
    filters: [`environment=eq.${controlPlaneEnv}`, `target_key=eq.${targetKey}`],
    limit: 1,
  });
  return rows[0] || null;
}

export async function getFieldMappings(supabase, targetId) {
  return supabase.select('monday_export_field_mappings', {
    columns:
      'id,target_id,monday_column_id,monday_column_name,source_field,value_type,' +
      'sync_direction,field_authority,conflict_policy,is_active,sync_order,' +
      'transform_type,transform_config',
    filters: [`target_id=eq.${targetId}`, 'is_active=eq.true'],
    order: 'sync_order',
  });
}
