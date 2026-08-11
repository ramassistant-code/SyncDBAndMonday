-- migrations/013_vat_and_amount_mappings.sql
-- Sync-fixes batch (Monday <-> DB). RUN ON THE PRODUCTION DATABASE.
-- Idempotent and transactional. Pairs with code changes in
--   server/engine/{align,enrich,diff}.js  and  server/index.js / apply.js.
--
-- ⚠ RUN ORDER (runbook — see prod_bootstrap/preview_013.mjs for a dry-run):
--   1. Preview:  node prod_bootstrap/preview_013.mjs         (read-only, shows impact)
--   2. Apply this file on prod.
--   3. IMMEDIATELY push deals DB->Monday so Monday's "מחיר כולל" shows the
--      pre-VAT total_amount for the ~4 deals where it currently differs, closing
--      the inbound-mismatch window BEFORE the next scheduled 08:00/13:00 pull:
--        POST /api/sync/apply { env:"production", direction:"db_to_monday",
--                               targetKey:"deal", confirmProduction:true }
--
-- Covers:
--   REQ 1  deal amount: total_amount = pre-VAT; total_amount_including_vat = total_amount*1.18
--   REQ 2  assignee_role: allow Hebrew labels (drop the English-enum CHECK)
--   REQ 5  internal_note -> credits note column is handled in code (enrich.js
--          derived push) — NO control-plane change needed here.

BEGIN;

-- ============================================================================
-- REQ 1 — deal amount semantics
-- ============================================================================

-- 1a) BACKFILL (must precede the trigger). The real pre-VAT amount currently
--     lives in total_amount_including_vat for the deals whose total_amount=0
--     (historically the sync wrote Monday's "מחיר כולל" into the incl column and
--     left total_amount at its 0 default). User-confirmed: the Monday amount is
--     WITHOUT VAT, so that stored value IS the pre-VAT total_amount.
UPDATE public.deals
   SET total_amount = total_amount_including_vat
 WHERE coalesce(total_amount, 0) = 0
   AND coalesce(total_amount_including_vat, 0) > 0;

-- 1b) VAT derivation trigger: total_amount_including_vat is ALWAYS round(total_amount*1.18,2).
--     Fires on INSERT and on UPDATE OF total_amount only, so unrelated updates
--     (payment_status, dates, …) never touch the incl column — and, critically,
--     never zero it out. Runs regardless of writer (sync / Replit / manual edit).
CREATE OR REPLACE FUNCTION public.deals_set_vat()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.total_amount_including_vat := round(coalesce(NEW.total_amount, 0) * 1.18, 2);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deals_set_vat ON public.deals;
CREATE TRIGGER trg_deals_set_vat
  BEFORE INSERT OR UPDATE OF total_amount ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deals_set_vat();

-- 1c) One-time recompute so EXISTING rows are consistent with the rule right now
--     (the trigger only affects future writes). Direct SET on the incl column
--     does NOT re-fire the "UPDATE OF total_amount" trigger.
UPDATE public.deals
   SET total_amount_including_vat = round(coalesce(total_amount, 0) * 1.18, 2)
 WHERE total_amount_including_vat IS DISTINCT FROM round(coalesce(total_amount, 0) * 1.18, 2);

-- 1d) Repoint the deal amount mapping: Monday "מחיר כולל" (numeric_mktnt9wf) now
--     maps to total_amount (pre-VAT). Result:
--       • OUTBOUND: only total_amount is pushed to Monday.
--       • INBOUND : Monday's amount lands in total_amount; the trigger derives incl.
UPDATE public.monday_export_field_mappings
   SET source_field = 'total_amount'
 WHERE monday_column_id = 'numeric_mktnt9wf'
   AND source_field = 'total_amount_including_vat';

-- ============================================================================
-- REQ 2 — assignee_role LABEL sync (deal_coordination_tasks)
-- ============================================================================
-- The mapping assignee_role -> color_mm57w197 ("אחראי", status) is already active
-- & bidirectional, and Monday writes use create_labels_if_missing. The only
-- blocker is the CHECK that restricts assignee_role to 3 English enum values;
-- Replit now writes Hebrew role labels, which would violate it. Drop it.
ALTER TABLE public.deal_coordination_tasks
  DROP CONSTRAINT IF EXISTS deal_coordination_tasks_assignee_role_check;

COMMIT;

-- ============================================================================
-- Post-apply verification (run manually; read-only)
-- ============================================================================
-- SELECT count(*) FILTER (WHERE total_amount = 0)                                    AS zero_total,
--        count(*) FILTER (WHERE total_amount_including_vat
--                              <> round(total_amount*1.18,2))                         AS vat_mismatch
--   FROM public.deals WHERE deleted_at IS NULL;                       -- expect 0 vat_mismatch
-- SELECT source_field FROM public.monday_export_field_mappings
--   WHERE monday_column_id = 'numeric_mktnt9wf';                      -- expect total_amount
