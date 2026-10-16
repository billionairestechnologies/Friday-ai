-- Phone config, per-user delivery settings, and the monthly minute ledger.
-- Applied later. The app keeps working from defaults until this exists.

create table if not exists public.phone_settings (
  id int primary key default 1 check (id = 1),
  config jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.phone_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  settings jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.phone_minutes (
  user_id uuid not null references auth.users (id) on delete cascade,
  month text not null,
  seconds int not null default 0,
  primary key (user_id, month)
);

alter table public.phone_settings enable row level security;
alter table public.phone_preferences enable row level security;
alter table public.phone_minutes enable row level security;
