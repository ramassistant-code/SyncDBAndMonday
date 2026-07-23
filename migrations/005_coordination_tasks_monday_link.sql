-- ============================================================================
-- 005_coordination_tasks_monday_link.sql
-- Add the Monday linkage columns to deal_coordination_tasks.
--
-- Bug (found live 2026-07-23 via the per-target n8n sync, target
-- "coordination_tasks"):
--   Supabase: column deal_coordination_tasks.monday_board_id does not exist
--
-- Root cause: the sync engine selects monday_board_id / monday_item_id /
-- monday_group_id on EVERY synced table (see server/engine/diff.js:29-32 and
-- the write-back in server/engine/apply.js:111-112,145). Every other business
-- table (customers/leads/deals/payments/credits/...) carries these columns,
-- but deal_coordination_tasks was never set up for sync and is missing them,
-- so its Monday->DB pass crashed before doing any work.
--
-- Fix: add the linkage columns (+ raw_data, matching the sibling convention).
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS) -> safe to run more than
-- once and on either environment (dev/test now, production later).
--
-- Review before running. Nothing here was executed for you.
-- ============================================================================

begin;
  alter table public.deal_coordination_tasks
    add column if not exists monday_board_id text,
    add column if not exists monday_item_id  text,
    add column if not exists monday_group_id text,
    add column if not exists raw_data        jsonb;

  -- Speeds up the linked-row lookup (monday_board_id + monday_item_id) that
  -- diff.js/apply.js do on every sync.
  create index if not exists idx_deal_coordination_tasks_monday
    on public.deal_coordination_tasks (monday_board_id, monday_item_id);
commit;
