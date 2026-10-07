-- Renewal reminders: one row per (person, plan end date, reminder). Plans now lapse to Free after
-- plan_renews_at (migration 0054 / billing/planSchedule.ts), and checkout sells one-time orders, so a
-- person has to be told before their plan ends. The primary key makes each reminder send at most
-- once per period, even with several app instances running the sweep.
-- No policies: backend only.

create table if not exists public.plan_reminders (
  user_id uuid not null references auth.users (id) on delete cascade,
  period_end timestamptz not null,
  kind text not null check (kind in ('3d', '1d', 'ended')),
  plan text not null,
  sent_at timestamptz not null default now(),
  channels text[] not null default '{}',
  primary key (user_id, period_end, kind)
);

alter table public.plan_reminders enable row level security;
