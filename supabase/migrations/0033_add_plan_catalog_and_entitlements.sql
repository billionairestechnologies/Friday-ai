-- ─────────────────────────────────────────────────────────────────────────
-- Plan catalog + entitlements.
--
-- Plans stop being constants in code: the Team Console edits each plan's
-- name, price, feature bullets, token limits and entitlements (Build Mode,
-- Deep Research, documents, custom skills, Library storage, Team Up size…),
-- and the public Plans page renders straight from this table. Code keeps
-- safe defaults, so a missing row or column never breaks billing.
--
-- Packages can now be PUBLIC (listed on the Plans page and bought through
-- Razorpay) and carry their own entitlements, which a grant copies onto the
-- person (profiles.entitlements) or organization (organizations.entitlements)
-- until the grant ends. Backend only: RLS on, no policies.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.plan_catalog (
  id text primary key check (id in ('free', 'pro', 'premium', 'enterprise')),
  name text not null,
  tagline text not null default '',
  -- Per month; per SEAT per month for enterprise.
  monthly_price_paise bigint not null default 0 check (monthly_price_paise >= 0),
  annual_discount_percent int not null default 10 check (annual_discount_percent between 0 and 90),
  min_seats int check (min_seats is null or min_seats > 0),
  features text[] not null default '{}',
  badge text,
  highlight boolean not null default false,
  -- Token limits; null = the code default (tierConfig.ts PLAN_LIMITS / ENTERPRISE_TOKENS_PER_SEAT).
  weekly_tokens bigint check (weekly_tokens is null or weekly_tokens > 0),
  rolling_tokens bigint check (rolling_tokens is null or rolling_tokens > 0),
  monthly_tokens bigint check (monthly_tokens is null or monthly_tokens > 0),
  tokens_per_seat bigint check (tokens_per_seat is null or tokens_per_seat > 0),
  entitlements jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  sort_order int not null default 0,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.plan_catalog enable row level security;
-- No policies: backend only.

insert into public.plan_catalog (id, name, tagline, monthly_price_paise, min_seats, features, highlight, sort_order)
values
  ('free', 'Free', 'Everything you need to get started.', 0, null,
    array['250K tokens a week', '50K tokens per 5-hour window', 'Chat, search, Canvas and images', 'Build Mode trial projects'], false, 0),
  ('pro', 'Pro', 'For daily work, research and building.', 99900, null,
    array['Everything in Free', '2.5M tokens a week (10M a month)', 'Flagship models', 'Full Build Mode with GitHub PRs', 'Deep Research, documents and skills'], true, 1),
  ('premium', 'Premium', 'The most capable Friday for power users.', 199900, null,
    array['Everything in Pro', '6.25M tokens a week (25M a month)', 'Reasoning and heavy models', 'Longest Build Mode runs', 'Largest Team Up panels and Library'], false, 2),
  ('enterprise', 'Enterprise', 'Pooled usage, admin controls and priority support for teams.', 249900, 3,
    array['Org-pooled tokens, no 5-hour lockout', 'Per-member caps set by your admins', 'Every model, priority handling', 'Centralized billing', 'Priority support'], false, 3)
on conflict (id) do nothing;

alter table public.plan_packages
  add column if not exists public boolean not null default false,
  add column if not exists entitlements jsonb not null default '{}'::jsonb,
  add column if not exists badge text,
  add column if not exists highlight boolean not null default false,
  add column if not exists sort_order int not null default 0;

alter table public.access_grants add column if not exists entitlements jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists entitlements jsonb not null default '{}'::jsonb;
alter table public.organizations add column if not exists entitlements jsonb not null default '{}'::jsonb;

-- Public packages are bought through the same order table.
alter table public.razorpay_orders
  drop constraint if exists razorpay_orders_plan_check;
alter table public.razorpay_orders
  add constraint razorpay_orders_plan_check
  check (plan in ('pro', 'premium', 'business', 'enterprise', 'package'));
