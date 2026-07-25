-- 008_discount_reason.sql
-- Adds free-text "discount reason" columns so the sync can carry the reason a
-- discount was given, to the matching (already-existing) Monday columns:
--
--   deals.discount_reason    → quote-level discount reason   (req 3)
--                              → Monday board 5100631737 col long_text_mm5jxpsv "סיבת הנחה"
--   credits.discount_reason  → component-level discount reason (req 2)
--                              → Monday board 5100631738 col long_text_mm5jd0ae "סיבת הנחה"
--
-- Idempotent. Run BEFORE 009 (which adds the field mappings that reference these
-- columns — the diff engine SELECTs them, so the mapping must not go active first).

ALTER TABLE public.deals   ADD COLUMN IF NOT EXISTS discount_reason text;
ALTER TABLE public.credits ADD COLUMN IF NOT EXISTS discount_reason text;
