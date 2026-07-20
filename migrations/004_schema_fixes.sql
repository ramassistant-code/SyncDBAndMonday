-- ============================================================================
-- 004_schema_fixes.sql
-- Categories א (consolidation) + ב (NOT NULL integrity), based on live data
-- probes (2026-07-20). Each fix is an INDEPENDENT transaction so you can run
-- them one at a time and a failure in one does not roll back the others.
--
-- Verified before writing:
--   * deals.customer_id / payments.deal_id / credits.deal_id : 0 NULLs across
--     ALL rows (incl. soft-deleted) -> NOT NULL is safe.
--   * deals.salesperson_user_id set on 9 rows, ALL of which have
--     salesperson_id NULL; 0 rows have BOTH set -> clean merge, no data loss.
--   * No server code and no monday_export_field_mappings reference
--     salesperson_user_id (only salesperson_note exists, unrelated).
--
-- Review before running. Nothing here was executed for you.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- ב) NOT NULL on always-populated FK columns
-- ----------------------------------------------------------------------------
begin;
  alter table deals    alter column customer_id set not null;
  alter table payments alter column deal_id     set not null;
  alter table credits  alter column deal_id     set not null;
commit;


-- ----------------------------------------------------------------------------
-- א.1) Consolidate the dual salesperson columns on deals — DATA MERGE (safe)
--      Move the 9 salesperson_user_id values into the canonical salesperson_id.
--      salesperson_id becomes the single source (288 rows total after this).
-- ----------------------------------------------------------------------------
begin;
  update deals
     set salesperson_id = salesperson_user_id
   where salesperson_user_id is not null
     and salesperson_id is null;
commit;


-- ----------------------------------------------------------------------------
-- א.2) Drop the now-redundant salesperson_user_id  (SAFE — verified)
--
--   Empirically verified (2026-07-20, read-only probe of v_deal_summary):
--   the view resolves salesperson_name via `salesperson_id` (deals with only
--   salesperson_id show a name; the 9 with only salesperson_user_id show NULL),
--   so v_deal_summary does NOT depend on salesperson_user_id. v_quote_summary
--   is on the quotes table (own salesperson col) and is unrelated.
--   No server code and no monday_export_field_mappings reference the column.
--   => the DROP is safe. Run it AFTER א.1 (so the 9 rows are preserved).
begin;
  alter table deals drop column salesperson_user_id;
commit;
--
--   OPTIONAL belt-and-suspenders — confirm nothing ELSE (other views, funcs,
--   triggers) depends on it before dropping. Expect ZERO rows:
--     select dependent_view.relname as dep_object
--     from pg_depend d
--     join pg_rewrite r on r.oid = d.objid
--     join pg_class dependent_view on dependent_view.oid = r.ev_class
--     join pg_class src on src.oid = d.refobjid
--     join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
--     where src.relname = 'deals' and a.attname = 'salesperson_user_id';
-- ----------------------------------------------------------------------------


-- ============================================================================
-- redundancy) customers.lead_id  <->  leads.linked_customer_id
--
-- These model the SAME customer<->lead link from both sides and DISAGREE
-- (529 vs 563 populated). This is a DATA-RECONCILIATION decision, not a blind
-- schema change — and both columns are used by the dedup engine
-- (server/engine/dedup.js re-points them). So NO destructive change here.
--
-- DIAGNOSTIC — see where the two sides disagree before deciding a direction:
--   -- customers pointing at a lead whose linked_customer_id is NOT this customer
--   select c.id as customer_id, c.lead_id, l.linked_customer_id
--   from customers c
--   join leads l on l.id = c.lead_id
--   where l.linked_customer_id is distinct from c.id;
--
--   -- leads pointing at a customer whose lead_id is NOT this lead
--   select l.id as lead_id, l.linked_customer_id, c.lead_id
--   from leads l
--   join customers c on c.id = l.linked_customer_id
--   where c.lead_id is distinct from l.id;
--
-- RECOMMENDATION: pick ONE as source of truth (customers.lead_id = "the lead a
-- customer originated from" is the natural 1:1). Then either (a) backfill the
-- other from it and add a trigger/derive it, or (b) drop the other after
-- updating dedup.js. Decide the direction first; I can write that migration next.
-- ============================================================================
