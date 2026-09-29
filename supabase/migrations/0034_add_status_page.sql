-- ─────────────────────────────────────────────────────────────────────────
-- Public status page (/status): component health probes, incidents with a
-- timeline of updates, and crash reports from the apps. Problem reports from
-- the status page become support tickets (no table of their own).
-- Backend only: RLS on, no policies.
-- ─────────────────────────────────────────────────────────────────────────

-- One row per probe run per component (API, database, cache, each model provider…).
create table if not exists public.status_checks (
  id bigint generated always as identity primary key,
  component text not null,
  ok boolean not null,
  latency_ms int,
  error text,
  checked_at timestamptz not null default now()
);
alter table public.status_checks enable row level security;
-- No policies: backend only.
create index if not exists status_checks_component_time_idx on public.status_checks (component, checked_at desc);
create index if not exists status_checks_time_idx on public.status_checks (checked_at);

create table if not exists public.status_incidents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  status text not null default 'investigating' check (status in ('investigating', 'identified', 'monitoring', 'resolved')),
  impact text not null default 'minor' check (impact in ('none', 'minor', 'major', 'critical')),
  components text[] not null default '{}',
  -- Opened automatically by the monitor when a component keeps failing (closed when it recovers).
  auto boolean not null default false,
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.status_incidents enable row level security;
-- No policies: backend only.
create index if not exists status_incidents_started_idx on public.status_incidents (started_at desc);

create table if not exists public.status_incident_updates (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.status_incidents (id) on delete cascade,
  status text not null check (status in ('investigating', 'identified', 'monitoring', 'resolved')),
  body text not null,
  author_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.status_incident_updates enable row level security;
-- No policies: backend only.
create index if not exists status_incident_updates_incident_idx on public.status_incident_updates (incident_id, created_at);

-- Crashes reported by the web/mobile apps (error boundary, unhandled errors), grouped by fingerprint.
create table if not exists public.crash_reports (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null,
  platform text not null default 'web' check (platform in ('web', 'android', 'ios')),
  message text not null,
  stack text,
  url text,
  user_agent text,
  release text,
  user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.crash_reports enable row level security;
-- No policies: backend only.
create index if not exists crash_reports_fingerprint_idx on public.crash_reports (fingerprint, created_at desc);
create index if not exists crash_reports_time_idx on public.crash_reports (created_at desc);

-- Daily uptime per component for the last N days (the 90-day bars on /status).
create or replace function public.status_daily(p_days int default 90)
returns table (component text, day date, total bigint, ok bigint, avg_latency_ms numeric)
language sql stable security definer set search_path = public as $$
  select component,
         (checked_at at time zone 'utc')::date as day,
         count(*) as total,
         count(*) filter (where ok) as ok,
         round(avg(latency_ms) filter (where ok), 0) as avg_latency_ms
  from public.status_checks
  where checked_at >= now() - make_interval(days => greatest(1, least(p_days, 365)))
  group by component, day
  order by component, day;
$$;
revoke all on function public.status_daily(int) from public, anon, authenticated;
grant execute on function public.status_daily(int) to service_role;

-- Crash groups for the console (newest first).
create or replace function public.crash_groups(p_days int default 14)
returns table (fingerprint text, platform text, message text, occurrences bigint, users bigint, first_seen timestamptz, last_seen timestamptz, sample_id uuid)
language sql stable security definer set search_path = public as $$
  select fingerprint,
         min(platform) as platform,
         min(message) as message,
         count(*) as occurrences,
         count(distinct user_id) as users,
         min(created_at) as first_seen,
         max(created_at) as last_seen,
         (array_agg(id order by created_at desc))[1] as sample_id
  from public.crash_reports
  where created_at >= now() - make_interval(days => greatest(1, least(p_days, 90)))
  group by fingerprint
  order by max(created_at) desc
  limit 200;
$$;
revoke all on function public.crash_groups(int) from public, anon, authenticated;
grant execute on function public.crash_groups(int) to service_role;

update public.staff_roles set permissions = array_append(permissions, 'status.manage')
  where id in ('operations', 'developer') and not ('status.manage' = any (permissions));
update public.staff_roles set permissions = array_append(permissions, 'status.view')
  where id in ('support', 'marketing', 'sales') and not ('status.view' = any (permissions));
