-- migrations/017_payment_fk_backfill_rerun.sql
-- Re-run of migration 015 step 3 (payments inherit customer_id / salesperson_id
-- from their linked deal) for the rows created AFTER 015 was applied — the window
-- in which the DB half of 015 was live but its code half (inbound FK inheritance,
-- commit 2d694d1) had not been deployed to the production branch.
-- RUN ON THE PRODUCTION DATABASE. Idempotent and transactional.
--
-- SCOPE — measured on live production 2026-08-24, BEFORE applying:
--   46 live payments have deal_id but no customer_id. Only 2 of them can be
--   filled: the other 44 hang off deals that carry NO customer_id themselves.
--   175 live deals are customer-less, every one of them created 2026-06/07 and
--   Monday-sourced (133 links last_source='monday', 42 never linked) — i.e. the
--   import-era rows, NOT something this backfill or the sync can repair. That is
--   a separate upstream job (resolve each deal's customer from its Monday
--   "לקוח מקושר" relation / party_snapshot).
--   salesperson_id: 0 rows to fill — only 16 of 1879 live deals have one at all.
--
-- ⚠ Runs with trg_payments_refresh_deal_totals DISABLED, for the same reason
--   migration 015 did: that trigger is AFTER INSERT OR DELETE OR UPDATE (any
--   column), so even an FK-only update fires it, and it rewrites the parent deal's
--   payment_status into a vocabulary 1868 of 1879 live deals do not use
--   ('ממתינה לתשלום' / 'תשלום חלקי' / 'שולמה במלואה' vs the live
--   'שולם' / 'שולם חלקית' / 'יש יתרה') — and sets deals.amount_paid_including_vat
--   to the PRE-VAT sum. Neither statement below touches amount_paid, so the totals
--   that trigger maintains cannot go stale: skipping it is safe AND required.
--   DISABLE + ENABLE live inside the transaction, so no concurrent writer ever
--   observes the trigger switched off.

BEGIN;

ALTER TABLE public.payments DISABLE TRIGGER trg_payments_refresh_deal_totals;

UPDATE public.payments p
   SET customer_id = d.customer_id
  FROM public.deals d
 WHERE p.deal_id = d.id
   AND p.deleted_at IS NULL
   AND p.customer_id IS NULL
   AND d.customer_id IS NOT NULL;

UPDATE public.payments p
   SET salesperson_id = d.salesperson_id
  FROM public.deals d
 WHERE p.deal_id = d.id
   AND p.deleted_at IS NULL
   AND p.salesperson_id IS NULL
   AND d.salesperson_id IS NOT NULL;

ALTER TABLE public.payments ENABLE TRIGGER trg_payments_refresh_deal_totals;

COMMIT;

-- ============================================================================
-- Post-apply verification (run manually; read-only)
-- ============================================================================
-- no_customer_but_deal_has_one must be 0; the remaining no_customer rows are the
-- ones blocked by customer-less deals:
-- SELECT count(*) FILTER (WHERE p.customer_id IS NULL)                       AS no_customer,
--        count(*) FILTER (WHERE p.customer_id IS NULL
--                           AND d.customer_id IS NOT NULL)                   AS no_customer_but_deal_has_one
--   FROM public.payments p JOIN public.deals d ON d.id = p.deal_id
--  WHERE p.deleted_at IS NULL;
--
-- Deal statuses must be untouched — expect 1671 'שולם', 149 'שולם חלקית',
-- 38 'יש יתרה', 10 'תשלום חלקי', 7 'שולמה במלואה', 3 'ממתינה לתשלום', 1 'צריך תשלום':
-- SELECT payment_status, count(*) FROM public.deals WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC;
