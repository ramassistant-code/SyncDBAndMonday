-- migrations/015_payment_vat_and_inbound_fks.sql
-- Payments: derive amount_paid_including_vat, and backfill the parent FKs that
-- Monday-created payments never got. RUN ON THE PRODUCTION DATABASE.
-- Idempotent and transactional. Pairs with the code change in
--   server/engine/enrich.js + server/engine/syncSingle.js  (inbound FK inheritance).
--
-- WHY (both reported symptoms have the same root):
--   The app reads a payment's amount from payments.amount_paid_including_vat, but
--   NOTHING derives that column: deals got a VAT trigger in migration 013,
--   payments never did, and the Monday mapping "סכום ששולם" (numeric_mktnyezv)
--   writes ONLY amount_paid. So:
--     • editing "סכום ששולם" in Monday moves amount_paid while
--       amount_paid_including_vat keeps its stale creation-time value → the app
--       shows the OLD amount and the deal's "שולם" summary no longer reconciles
--       with the payment line;
--     • a payment CREATED in Monday lands with amount_paid_including_vat at its
--       DEFAULT 0 → the app shows 0 ₪.
--   1898 of the 1904 live payments (every Monday-sourced row) sit at incl = 0.
--
--   Same VAT convention as deals (migration 013, user-confirmed): the Monday
--   amount is WITHOUT VAT, so amount_paid is the pre-VAT figure and
--   amount_paid_including_vat = round(amount_paid * 1.18, 2).
--
--   Separately, an inbound payment resolves deal_id from the "עסקה מקושרת"
--   board_relation but customer_id / salesperson_id stay NULL (1698 live rows).
--   They are inherited from the linked deal here and, going forward, in the
--   inbound sync path.
--
-- ⚠ The backfills run with trg_payments_refresh_deal_totals DISABLED. That
--   trigger recomputes deals.payment_status from a formula whose vocabulary
--   ('ממתינה לתשלום' / 'תשלום חלקי' / 'שולמה במלואה') is NOT the vocabulary
--   1822 of 1832 live deals actually use ('שולם' / 'שולם חלקית' / 'יש יתרה').
--   Letting it fire on 1898 backfilled payments would rewrite those statuses and
--   push the rewrite to Monday. Neither backfill changes amount_paid, so the deal
--   totals it maintains are unaffected — skipping it is safe AND required.

BEGIN;

-- ============================================================================
-- 1 — VAT derivation on payments (mirrors deals_set_vat from migration 013)
-- ============================================================================
-- Fires on INSERT and on UPDATE OF amount_paid only, so unrelated updates
-- (status, dates, the FK backfill below…) never touch the incl column.
-- Runs regardless of writer: sync / Replit / manual edit.
CREATE OR REPLACE FUNCTION public.payments_set_vat()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.amount_paid_including_vat := round(coalesce(NEW.amount_paid, 0) * 1.18, 2);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_set_vat ON public.payments;
CREATE TRIGGER trg_payments_set_vat
  BEFORE INSERT OR UPDATE OF amount_paid ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.payments_set_vat();

-- ============================================================================
-- 2 — one-time recompute for EXISTING rows (the trigger only affects new writes)
-- ============================================================================
ALTER TABLE public.payments DISABLE TRIGGER trg_payments_refresh_deal_totals;

UPDATE public.payments
   SET amount_paid_including_vat = round(coalesce(amount_paid, 0) * 1.18, 2)
 WHERE amount_paid_including_vat IS DISTINCT FROM round(coalesce(amount_paid, 0) * 1.18, 2);

-- ============================================================================
-- 3 — backfill customer_id / salesperson_id from the linked deal
-- ============================================================================
-- Only fills what is NULL — a payment that carries its own customer/salesperson
-- keeps it. Deals that have no salesperson_id themselves leave the payment NULL.
UPDATE public.payments p
   SET customer_id = d.customer_id
  FROM public.deals d
 WHERE p.deal_id = d.id
   AND p.customer_id IS NULL
   AND d.customer_id IS NOT NULL;

UPDATE public.payments p
   SET salesperson_id = d.salesperson_id
  FROM public.deals d
 WHERE p.deal_id = d.id
   AND p.salesperson_id IS NULL
   AND d.salesperson_id IS NOT NULL;

ALTER TABLE public.payments ENABLE TRIGGER trg_payments_refresh_deal_totals;

COMMIT;

-- ============================================================================
-- Post-apply verification (run manually; read-only)
-- ============================================================================
-- SELECT count(*)                                                              AS live_payments,
--        count(*) FILTER (WHERE amount_paid_including_vat
--                             <> round(amount_paid*1.18,2))                    AS vat_mismatch,   -- expect 0
--        count(*) FILTER (WHERE deal_id IS NOT NULL AND customer_id IS NULL)    AS no_customer
--   FROM public.payments WHERE deleted_at IS NULL;
--
-- Deal statuses must be untouched by this migration — expect the same counts as
-- before (1639 'שולם', 149 'שולם חלקית', 34 'יש יתרה', …):
-- SELECT payment_status, count(*) FROM public.deals WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC;
