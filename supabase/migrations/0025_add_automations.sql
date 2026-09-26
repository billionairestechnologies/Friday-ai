-- Automations: prompts Friday runs on a schedule (hourly / daily / weekdays / weekly at a local time)
-- in the background. Each automation writes into its own chat thread and sends a push notification.
-- `running_until` is a lease: a scheduler instance claims a due row by setting it in one UPDATE, so
-- several API instances never run the same automation twice.
create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  prompt text not null check (char_length(prompt) between 1 and 8000),
  frequency text not null check (frequency in ('hourly', 'daily', 'weekdays', 'weekly')),
  time_of_day text not null default '09:00' check (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  weekday int check (weekday between 0 and 6),
  timezone text not null default 'UTC',
  research boolean not null default false,
  enabled boolean not null default true,
  conversation_id uuid references public.conversations (id) on delete set null,
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_status text check (last_status in ('ok', 'error')),
  last_error text,
  running_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists automations_due_idx on public.automations (next_run_at) where enabled;
create index if not exists automations_user_idx on public.automations (user_id, created_at);
alter table public.automations enable row level security;
-- No policies: only the backend (service role) reads/writes this table.
