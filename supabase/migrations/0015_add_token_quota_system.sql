-- ─────────────────────────────────────────────────────────────────────────
-- Token quota system: individual plan tiers (free/pro/premium), enterprise
-- org token pooling, per-model tier gating, and a dedicated per-completion
-- ledger for quota reconciliation + admin profitability reporting.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.profiles
  add column if not exists plan text not null default 'free' check (plan in ('free', 'pro', 'premium')),
  add column if not exists plan_renews_at timestamptz,
  add column if not exists custom_monthly_cap bigint;

alter table public.organizations
  add column if not exists seat_count int not null default 3,
  add column if not exists pooled_monthly_tokens bigint,
  add column if not exists billing_cycle_anchor timestamptz not null default now();

alter table public.provider_models
  add column if not exists min_tier text not null default 'free' check (min_tier in ('free', 'pro', 'premium'));

-- Best-effort seed for the flagship/reasoning models named in the pricing spec — admin can
-- always override per-model afterward from the admin panel's model list.
update public.provider_models
set min_tier = 'pro'
where min_tier = 'free'
  and (
    model_id ilike '%gpt-4o%' or model_id ilike '%gpt-5%'
    or model_id ilike '%sonnet%' or model_id ilike '%claude-3-5%'
  )
  and model_id not ilike '%mini%' and model_id not ilike '%haiku%';

update public.provider_models
set min_tier = 'premium'
where model_id ilike '%opus%' or model_id ilike '%o1%' or model_id ilike '%o3%' or model_id ilike '%reasoning%';

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
  created_at timestamptz not null default now()
);

alter table public.token_ledger enable row level security;

drop policy if exists "token_ledger: owner read" on public.token_ledger;
create policy "token_ledger: owner read" on public.token_ledger
  for select using (auth.uid() = user_id);

drop policy if exists "token_ledger: admin read" on public.token_ledger;
create policy "token_ledger: admin read" on public.token_ledger
  for select using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create index if not exists token_ledger_user_created_idx
  on public.token_ledger (user_id, created_at desc);
create index if not exists token_ledger_org_created_idx
  on public.token_ledger (organization_id, created_at desc);
