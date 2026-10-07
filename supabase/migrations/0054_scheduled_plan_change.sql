-- Plan changes that wait for the current plan to end.
--
-- A Premium subscriber who bought Pro was switched to Pro the moment the payment landed, losing the
-- Premium days they had already paid for. A downgrade now waits: the paid-for plan is stored here and
-- becomes the active plan when plan_renews_at passes (backend: services/billing/planSchedule.ts).
-- The scheduled plan starts exactly at plan_renews_at, so extending the current plan moves it too.
-- Columns only on profiles (already RLS-on, backend only); no new table, no policies needed.

alter table public.profiles
  add column if not exists scheduled_plan text check (scheduled_plan in ('pro', 'premium')),
  add column if not exists scheduled_plan_days integer check (scheduled_plan_days is null or scheduled_plan_days > 0),
  add column if not exists scheduled_plan_order_id text;

-- The rollover/expiry sweep scans paid plans whose period has ended.
create index if not exists profiles_plan_renews_at_idx
  on public.profiles (plan_renews_at)
  where plan in ('pro', 'premium') and plan_renews_at is not null;
