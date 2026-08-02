-- 011_enable_products_components_inbound.sql
-- Enable Monday → DB sync for the PRODUCTS and COMPONENTS boards.
--
-- Problem: three quote-level fields never sync from Monday to the app —
--   • products.quote_description_default   ("תיאור מוצר ברמת הצעת מחיר")
--   • products.quote_notes_default         ("הערות למוצר ברמת הצעת מחיר")
--   • components.quote_description_default  ("תיאור רכיב ברמת הצעת מחיר")
-- The field MAPPINGS are fine (active, bidirectional, monday_wins) and the DB
-- columns exist. The block is at the TARGET level: both the `products` and
-- `component_operations` targets have is_active=false AND inbound_enabled=false,
-- so every inbound event is dropped before any field is inspected:
--   • webhook path      — syncSingle.js:83  (checks inbound_enabled)
--   • scheduled pull     — index.js:226      (checks is_active AND inbound_enabled)
-- Both flags must be true for Monday → DB to run through either path.
--
-- NOTE: is_active=true also re-enables outbound (DB → Monday) for these boards.
-- All their field mappings are monday_wins, so Monday stays authoritative, but an
-- app-side edit will now push back to Monday. This is unavoidable — the scheduled
-- inbound pull is gated on is_active.
--
-- SCOPE: enables ALL mapped fields on these two boards (not only the three above),
-- because inbound is gated per-target, not per-field.
--
-- Idempotent. environment='test' ONLY. Swap to 'production' when promoting.

UPDATE public.monday_export_targets
   SET is_active = true, inbound_enabled = true, updated_at = now()
 WHERE environment = 'test'
   AND target_key IN ('products', 'component_operations');
