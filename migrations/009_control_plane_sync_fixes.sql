-- 009_control_plane_sync_fixes.sql
-- Control-plane (config) changes for the sync fixes. Data only — no schema.
-- Run AFTER 008 (the discount mappings reference columns 008 adds).
-- Idempotent. Written for environment='test'. For PRODUCTION: re-run each
-- statement with environment='production' AND verify the Monday column ids match
-- the prod boards first (see SYNC_FIXES.md — board_relation ids are identical
-- dev↔prod, but recently-added columns must be confirmed).

-- ── (1) Activate the salespeople ↔ app_users target (req 1) ──────────────────
-- The target + its field mappings already exist; it was just switched off.
UPDATE public.monday_export_targets
   SET is_active = true, inbound_enabled = true, outbound_enabled = true, updated_at = now()
 WHERE environment = 'test' AND target_key = 'salespeople';

-- ── (2) Deal-level discount reason (req 3) ───────────────────────────────────
--     deals.discount_reason ↔ long_text_mm5jxpsv ("סיבת הנחה" on the deals board)
INSERT INTO public.monday_export_field_mappings
  (target_id, monday_column_id, monday_column_name, source_field, value_type,
   transform_type, transform_config, required, sync_order, is_active,
   sync_direction, field_authority, conflict_policy,
   inbound_transform_config, outbound_transform_config,
   allow_null_inbound, allow_null_outbound, inbound_validation, is_sensitive)
SELECT t.id, 'long_text_mm5jxpsv', 'סיבת הנחה', 'discount_reason', 'long_text',
       'direct', '{}'::jsonb, false, 90, true,
       'bidirectional', 'monday', 'monday_wins',
       '{}'::jsonb, '{}'::jsonb, false, true, '{}'::jsonb, false
  FROM public.monday_export_targets t
 WHERE t.environment = 'test' AND t.target_key = 'deal'
   AND NOT EXISTS (SELECT 1 FROM public.monday_export_field_mappings m
                    WHERE m.target_id = t.id AND m.monday_column_id = 'long_text_mm5jxpsv');

-- ── (3) Component-level discount reason (req 2) ──────────────────────────────
--     credits.discount_reason ↔ long_text_mm5jd0ae ("סיבת הנחה" on the credits board)
INSERT INTO public.monday_export_field_mappings
  (target_id, monday_column_id, monday_column_name, source_field, value_type,
   transform_type, transform_config, required, sync_order, is_active,
   sync_direction, field_authority, conflict_policy,
   inbound_transform_config, outbound_transform_config,
   allow_null_inbound, allow_null_outbound, inbound_validation, is_sensitive)
SELECT t.id, 'long_text_mm5jd0ae', 'סיבת הנחה', 'discount_reason', 'long_text',
       'direct', '{}'::jsonb, false, 90, true,
       'bidirectional', 'monday', 'monday_wins',
       '{}'::jsonb, '{}'::jsonb, false, true, '{}'::jsonb, false
  FROM public.monday_export_targets t
 WHERE t.environment = 'test' AND t.target_key = 'credits'
   AND NOT EXISTS (SELECT 1 FROM public.monday_export_field_mappings m
                    WHERE m.target_id = t.id AND m.monday_column_id = 'long_text_mm5jd0ae');

-- Note: the "note from salesperson at quote time" (req 4) already flows —
-- credits.salesperson_note ↔ long_text_mkvcfdhq is an existing active mapping.
-- The board_relation links (req 5,8), composed titles (req 6) and the payments
-- "salesperson" status = full name (req 7) are handled in engine code
-- (server/engine/enrich.js), NOT via control-plane rows.
