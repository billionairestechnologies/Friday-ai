-- Minimal stand-in for the tables migration 0051 builds on (the real ones come from 0001…0050,
-- which need Supabase's auth/storage schemas). Only the columns 0051 reads or writes are here.
-- Used by test/quotaLedger.db.test.ts against a throwaway Postgres (QUOTA_TEST_DATABASE_URL).

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  plan text not null default 'free',
  plan_renews_at timestamptz,
  custom_monthly_cap bigint,
  created_at timestamptz not null default now()
);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Org',
  slug text not null default gen_random_uuid()::text,
  plan text not null default 'free',
  seat_count int not null default 3,
  pooled_monthly_tokens bigint,
  billing_cycle_anchor timestamptz not null default now()
);

create table if not exists public.token_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  provider_slug text not null,
  model_id text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  total_tokens bigint not null default 0,
  estimated_cost_cents numeric not null default 0,
  reserved_tokens bigint not null default 0,
  cached_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  cost_usd numeric(16, 8),
  sell_inr numeric(16, 6),
  priced boolean not null default false,
  feature text,
  created_at timestamptz not null default now()
);

create table if not exists public.plan_catalog (
  id text primary key,
  name text not null,
  features text[] not null default '{}',
  weekly_tokens bigint,
  rolling_tokens bigint,
  monthly_tokens bigint,
  tokens_per_seat bigint
);
insert into public.plan_catalog (id, name, features, weekly_tokens, rolling_tokens, monthly_tokens, tokens_per_seat) values
  ('free', 'Free', array['Light daily usage, refreshed every 5 hours and weekly', 'Chat'], 6500, 2500, null, null),
  ('pro', 'Pro', array['Everything in Free', 'Generous usage every 5 hours, week and month'], 110000, 60000, 450000, null),
  ('premium', 'Premium', array['About 2x Pro''s usage, the most for one person'], 210000, 120000, 900000, null),
  ('enterprise', 'Enterprise', array['Org-pooled monthly usage, no 5-hour lockout'], null, null, null, 1000000)
on conflict (id) do nothing;

create table if not exists public.plan_packages (
  id uuid primary key default gen_random_uuid(),
  monthly_token_cap bigint,
  pooled_monthly_tokens bigint
);

create table if not exists public.access_grants (
  id uuid primary key default gen_random_uuid(),
  monthly_token_cap bigint,
  pooled_monthly_tokens bigint
);

create table if not exists public.meter_unit (
  id boolean primary key default true check (id),
  unit text not null,
  converted_at timestamptz not null default now()
);
insert into public.meter_unit (id, unit) values (true, 'credits') on conflict (id) do nothing;
