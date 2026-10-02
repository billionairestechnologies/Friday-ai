-- Provider issues: every time a model/image/search provider fails in a way users must not see (out of credit,
-- gateway errors, rate limits, rejected keys), one grouped row per (provider, kind) is kept here so the team
-- sees it in Team Console → Status → Provider issues instead of users seeing raw vendor errors.
create table if not exists public.provider_issues (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  kind text not null check (kind in ('quota', 'gateway', 'rate_limit', 'auth', 'too_large', 'other')),
  sample text not null,
  occurrences integer not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  alerted_at timestamptz,
  resolved_at timestamptz
);
alter table public.provider_issues enable row level security;
-- No policies: backend only.
-- One OPEN issue per provider + kind; a resolved one is history and a recurrence opens a new row.
create unique index if not exists provider_issues_open_idx on public.provider_issues (provider, kind) where resolved_at is null;
create index if not exists provider_issues_last_seen_idx on public.provider_issues (last_seen desc);
