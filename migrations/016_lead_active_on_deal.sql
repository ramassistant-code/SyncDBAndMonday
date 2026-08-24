-- migrations/016_lead_active_on_deal.sql
-- "עסקה נפתחה במערכת → סטטוס הליד = 'לקוח פעיל'".
-- RUN ON THE PRODUCTION DATABASE. Idempotent and transactional.
-- Pairs with the code change in server/engine/syncSingle.js (syncDealGraph now
-- always pushes the deal's lead to Monday).
--
-- WHY:
--   Opening a deal is supposed to flip the originating lead to 'לקוח פעיל', but
--   NOTHING did it: there is no such trigger in the DB and the app (Replit) only
--   writes deals/customers — the lead row is touched without its status. Proof on
--   live production (2026-08-24): of the 3 deals that carry a lead_id, the one
--   from 2026-08-15 (D-2026-001746 → L-003364) still sits at 'חדש' on BOTH sides,
--   and the two that DO read 'לקוח פעיל' got that value FROM Monday — their
--   monday_entity_links rows say last_source='monday', with the lead's updated_at
--   landing ~5s after the Monday item's, i.e. a human changed it by hand in Monday
--   and the inbound webhook copied it down. Not one of the 787 lead links has ever
--   been written from the DB side (all 787 are last_source='monday').
--
--   So the status stays whatever Monday says ('בתהליך'), which is exactly the
--   reported symptom. This trigger makes the flip a property of the DATA, not of
--   whichever client wrote the deal (Replit app, sync engine, manual SQL).
--
-- NOTE: the DB flip alone is not enough — DB→Monday only ever happens on the
--   /api/push path, and the twice-daily scheduled sync is Monday→DB, so an
--   un-pushed DB status would be overwritten back on the next pull. That is what
--   the syncSingle.js change fixes.

BEGIN;

-- The status value must exist in the curated lookup (leads.status has an FK to
-- lookup_lead_status). It does today (654 leads carry it) — this is a guard so
-- the migration cannot fail on a fresh/rebuilt environment.
INSERT INTO public.lookup_lead_status (value, sort_order, is_active)
VALUES ('לקוח פעיל', 50, true)
ON CONFLICT (value) DO NOTHING;

-- ============================================================================
-- 1 — the rule
-- ============================================================================
-- Fires when a deal is created with a lead, and when an existing deal gets its
-- lead_id set/changed later (e.g. the inbound "לידים" board_relation resolving to
-- an FK). Never downgrades a lead that is already 'לקוח פעיל', and never touches
-- a soft-deleted lead.
CREATE OR REPLACE FUNCTION public.deals_mark_lead_active()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lead_id IS NULL OR NEW.deleted_at IS NOT NULL THEN
    RETURN NULL;                       -- AFTER trigger: return value is ignored
  END IF;

  UPDATE public.leads
     SET status = 'לקוח פעיל'
   WHERE id = NEW.lead_id
     AND deleted_at IS NULL
     AND status IS DISTINCT FROM 'לקוח פעיל';

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_deals_mark_lead_active ON public.deals;
CREATE TRIGGER trg_deals_mark_lead_active
  AFTER INSERT OR UPDATE OF lead_id ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deals_mark_lead_active();

-- ============================================================================
-- 2 — one-time backfill for deals that already exist
-- ============================================================================
-- Today this is a single row (L-003364, deal D-2026-001746, still 'חדש'); the
-- other 1876 live deals carry no lead_id at all, so they are untouched.
--
-- ⚠ This only fixes the DB. The corresponding Monday item keeps its old status
--   until the lead is pushed — see PROD_GOLIVE / README for /api/push:
--     curl -X POST "$SYNC_URL/api/push" -H "x-api-key: $SYNC_API_KEY" \
--       -H 'content-type: application/json' \
--       -d '{"env":"production","confirmProduction":true,"action":"lead_upserted","id":"<lead uuid>"}'
UPDATE public.leads l
   SET status = 'לקוח פעיל'
 WHERE l.deleted_at IS NULL
   AND l.status IS DISTINCT FROM 'לקוח פעיל'
   AND EXISTS (SELECT 1 FROM public.deals d
                WHERE d.lead_id = l.id AND d.deleted_at IS NULL);

COMMIT;

-- ============================================================================
-- Post-apply verification (run manually; read-only)
-- ============================================================================
-- Expect not_active = 0:
-- SELECT count(*) FILTER (WHERE l.status = 'לקוח פעיל')            AS active,
--        count(*) FILTER (WHERE l.status IS DISTINCT FROM 'לקוח פעיל') AS not_active
--   FROM public.deals d JOIN public.leads l ON l.id = d.lead_id
--  WHERE d.deleted_at IS NULL AND l.deleted_at IS NULL;
