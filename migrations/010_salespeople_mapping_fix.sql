-- 010_salespeople_mapping_fix.sql
-- Makes the salespeople sync fully BIDIRECTIONAL and safe.
--   • Replit → DB : direct Postgres write (always, not controlled here).
--   • DB → Monday : push on salesperson_upserted (outbound_enabled).
--   • Monday → DB : scheduled pull + webhook (inbound_enabled) — an edit made in
--                   the Monday salespeople board syncs back to app_users.
--
-- The ONLY thing that must change is the broken role↔status mapping: the board
-- "סטטוס" column is פעיל/לא פעיל (an is_active flag), but it was mapped to
-- app_users.role, which is the user_role ENUM (sales/admin/…). That mapping makes
-- the Monday→DB pull FAIL ("לא פעיל" is not a valid enum value) and pushes junk
-- labels ("sales") to Monday. Every other field (full_name, phone, email) is fine
-- both ways. So: keep the target fully bidirectional, just disable that one field.
--
-- Idempotent. Written for environment='test'; swap to 'production' for prod.

-- (1) full bidirectional (re-assert in case an earlier attempt disabled inbound)
UPDATE public.monday_export_targets
   SET is_active = true, inbound_enabled = true, outbound_enabled = true, updated_at = now()
 WHERE environment = 'test' AND target_key = 'salespeople';

-- (2) disable the role↔status mapping (the only unsafe field)
UPDATE public.monday_export_field_mappings m
   SET is_active = false, updated_at = now()
  FROM public.monday_export_targets t
 WHERE m.target_id = t.id
   AND t.environment = 'test' AND t.target_key = 'salespeople'
   AND m.monday_column_id = 'status' AND m.source_field = 'role';
