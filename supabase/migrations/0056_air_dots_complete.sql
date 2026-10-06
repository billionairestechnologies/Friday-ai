-- Air Dots, finished: everything that lived in one server's memory moves here, so a restart or a
-- second instance can't lose a job, let "rukho" land on the wrong server, or forget a call.
-- No policies: backend only (RLS on, the backend uses the service role).

-- ── Jobs ─────────────────────────────────────────────────────────────────────
-- One Air Dot = one job row. The owning instance holds a lease and renews it; a job whose lease
-- runs out (crash, deploy) is picked up by another instance and continues.
create table if not exists public.air_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  task text not null,
  source text not null default 'web' check (source in ('web', 'phone', 'whatsapp', 'telegram', 'approval')),
  status text not null default 'running'
    check (status in ('running', 'done', 'blocked', 'needs_login', 'needs_approval', 'stopped', 'failed', 'out_of_meter')),
  summary text,
  needs text,
  rounds int not null default 0,
  stop_requested boolean not null default false,
  urgent boolean not null default false,
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists air_jobs_conversation_idx on public.air_jobs (conversation_id, created_at desc);
create index if not exists air_jobs_running_idx on public.air_jobs (lease_until) where status = 'running';
create unique index if not exists air_jobs_one_running on public.air_jobs (conversation_id) where status = 'running';
alter table public.air_jobs enable row level security;

-- ── The gate ─────────────────────────────────────────────────────────────────
-- Every shell, browser, file and connector action an Air Dot takes, allowed or refused.
create table if not exists public.air_actions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  job_id uuid references public.air_jobs (id) on delete set null,
  kind text not null check (kind in ('file', 'shell', 'browser', 'tool', 'connector')),
  name text not null,
  detail text not null default '',
  decision text not null check (decision in ('allowed', 'refused', 'approved')),
  created_at timestamptz not null default now()
);
create index if not exists air_actions_conversation_idx on public.air_actions (conversation_id, created_at desc);
create index if not exists air_actions_user_idx on public.air_actions (user_id, created_at desc);
alter table public.air_actions enable row level security;

-- A yes (plus the passphrase once set) opens leaving actions on one conversation for a short window.
create table if not exists public.air_approvals (
  conversation_id uuid primary key references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  until timestamptz not null,
  via text not null default 'web'
);
alter table public.air_approvals enable row level security;

-- ── Calls ────────────────────────────────────────────────────────────────────
-- air_calls (0052) becomes the call record: the trunk's own call id, who, which way, the transcript
-- (the words, never the audio), and the seconds that were billed.
alter table public.air_calls
  add column if not exists external_id text,
  add column if not exists trunk text,
  add column if not exists direction text not null default 'browser',
  add column if not exists from_number text,
  add column if not exists greeting text,
  add column if not exists transcript jsonb not null default '[]'::jsonb,
  add column if not exists seconds int not null default 0,
  add column if not exists ended_at timestamptz,
  add column if not exists summary text;
alter table public.air_calls drop constraint if exists air_calls_status_check;
alter table public.air_calls
  add constraint air_calls_status_check check (status in ('dialing', 'open', 'ended'));
alter table public.air_calls drop constraint if exists air_calls_direction_check;
alter table public.air_calls
  add constraint air_calls_direction_check check (direction in ('browser', 'inbound', 'outbound', 'callback'));
create unique index if not exists air_calls_external_idx on public.air_calls (external_id) where external_id is not null;
create index if not exists air_calls_user_idx on public.air_calls (user_id, created_at desc);

-- Caller ID is the login: look a number up by its last 10 digits through an index instead of
-- reading every profile with a phone (the old lookup scanned the whole table on each call).
alter table public.profiles
  add column if not exists phone_last10 text generated always as (
    nullif(right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10), '')
  ) stored;
create index if not exists profiles_phone_last10_idx on public.profiles (phone_last10) where phone_last10 is not null;

-- Passphrase lockout: 5 wrong tries lock it for 15 minutes.
alter table public.profiles
  add column if not exists air_passphrase_failures int not null default 0,
  add column if not exists air_passphrase_locked_until timestamptz;

-- Call minutes: one atomic add, so two instances ending calls at once can't lose seconds.
create or replace function public.air_add_call_seconds(p_user uuid, p_month text, p_seconds int)
returns int
language sql
security definer
set search_path = public
as $$
  insert into public.phone_minutes (user_id, month, seconds)
  values (p_user, p_month, greatest(p_seconds, 0))
  on conflict (user_id, month) do update set seconds = public.phone_minutes.seconds + greatest(excluded.seconds, 0)
  returning seconds;
$$;
revoke all on function public.air_add_call_seconds(uuid, text, int) from public, anon, authenticated;

-- The browser that Air Dots drives (and the person sees on the screen) — remembered here so any
-- instance can reach it, not only the one that started it.
create table if not exists public.browser_sessions (
  conversation_id uuid primary key references public.conversations (id) on delete cascade,
  sandbox_id text not null,
  updated_at timestamptz not null default now()
);
alter table public.browser_sessions enable row level security;

-- ── Product updates ──────────────────────────────────────────────────────────
-- One featured card on the Air Dots home (an update marked featured, not a second ad product).
alter table public.announcements add column if not exists featured boolean not null default false;
