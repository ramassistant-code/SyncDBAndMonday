-- ============================================================================
-- 007_deal_payment_status_enum.sql
-- Add the missing values to the deal_payment_status Postgres enum.
--
-- Bug (found live 2026-07-23, deal sync, AFTER migration 006 fixed the
-- execution_status enum): the same 48 create rows then failed on the next enum
-- column, deals.payment_status:
--   46x  invalid input value for enum deal_payment_status: "שולם"
--    2x  invalid input value for enum deal_payment_status: "שולם חלקית"
--
-- Same class of issue as 006: payment_status is a real Postgres ENUM, Monday
-- holds labels the type does not allow, and ensureLookups() cannot extend an
-- enum. Monday = source of truth in test -> extend the enum.
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction block; the new
-- values are usable only after each statement commits. Run standalone (no
-- begin/commit). Idempotent via IF NOT EXISTS.
--
-- Review before running. Nothing here was executed for you.
-- ============================================================================

alter type deal_payment_status add value if not exists 'שולם';
alter type deal_payment_status add value if not exists 'שולם חלקית';
