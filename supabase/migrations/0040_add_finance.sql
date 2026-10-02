-- Finance: exact model pricing (what we pay vs what we charge), per-call cost in the ledger, the
-- company's other expenses, and the settings that turn them into a P&L.
--
-- Before this, token_ledger.estimated_cost_cents came from one flat guess per PROVIDER (every
-- Anthropic model priced the same, and wrongly), so the admin "profit" number could be off by 10x.

-- One row per model. Cost = what the provider (or reseller: ScaleMax, OpenRouter…) charges us per
-- 1M tokens; sell = what we charge per 1M tokens (INR), shown to users when `is_public`.
create table if not exists public.model_pricing (
  id uuid primary key default gen_random_uuid(),
  provider_slug text not null,
  model_id text not null,
  display_name text,
  -- What we pay, per 1 million tokens, in cost_currency.
  cost_currency text not null default 'USD' check (cost_currency in ('USD', 'INR')),
  cost_input_per_m numeric(14, 6),
  cost_output_per_m numeric(14, 6),
  cost_cache_read_per_m numeric(14, 6),
  cost_cache_write_per_m numeric(14, 6),
  -- Image models are billed per image, not per token.
  cost_per_image numeric(14, 6),
  -- Who we buy it from and where the numbers came from (e.g. "OpenRouter list price", "ScaleMax invoice").
  cost_source text not null default '',
  -- What we charge, per 1 million tokens, in INR. Null = cost × FX × (1 + default markup).
  sell_input_per_m_inr numeric(14, 4),
  sell_output_per_m_inr numeric(14, 4),
  sell_per_image_inr numeric(14, 4),
  is_public boolean not null default false,
  notes text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (provider_slug, model_id)
);

-- No policies: backend only
alter table public.model_pricing enable row level security;

-- Single-row settings. usd_to_inr is the rate the books use (set it from your bank/forex statement);
-- default_markup_pct prices a model whose sell price isn't set explicitly.
create table if not exists public.finance_settings (
  id boolean primary key default true check (id),
  usd_to_inr numeric(10, 4) not null default 88,
  default_markup_pct numeric(8, 2) not null default 40,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.finance_settings (id) values (true) on conflict (id) do nothing;

-- No policies: backend only
alter table public.finance_settings enable row level security;

-- Exact per-call economics, priced at the moment of the call (later price edits don't rewrite history).
alter table public.token_ledger add column if not exists cost_usd numeric(16, 8);
alter table public.token_ledger add column if not exists sell_inr numeric(16, 6);
-- false = no model_pricing row existed; cost_usd then holds the old per-provider estimate.
alter table public.token_ledger add column if not exists priced boolean not null default false;

create index if not exists token_ledger_created_idx on public.token_ledger (created_at desc);
create index if not exists token_ledger_model_created_idx on public.token_ledger (provider_slug, model_id, created_at desc);

-- Everything else the company spends money on: servers, salaries, tools, ads, provider top-ups.
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  category text not null default 'other',
  vendor text not null default '',
  description text not null default '',
  amount numeric(14, 2) not null check (amount >= 0),
  currency text not null default 'INR' check (currency in ('INR', 'USD')),
  -- The INR value booked (USD converted at the rate on the day it was entered, or as typed).
  amount_inr numeric(14, 2) not null check (amount_inr >= 0),
  incurred_on date not null default current_date,
  recurrence text not null default 'none' check (recurrence in ('none', 'monthly', 'yearly')),
  payment_method text not null default '',
  reference text not null default '',
  -- Provider credit top-ups: tracked as cash out, but excluded from the P&L because the model usage
  -- they pay for is already counted from token_ledger (counting both would double the AI cost).
  is_model_credits boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists expenses_incurred_idx on public.expenses (incurred_on desc) where deleted_at is null;

-- No policies: backend only
alter table public.expenses enable row level security;

-- Per-model usage totals for a window, aggregated in the database (the API can't page through
-- millions of ledger rows; PostgREST also caps a plain select at 1000 rows, which silently
-- truncated the old profitability sum). Priced rows contribute their stored cost/sell; unpriced
-- rows contribute tokens only, priced afterwards at the current rate.
create or replace function public.finance_model_usage(since timestamptz, until timestamptz default now())
returns table (
  provider_slug text,
  model_id text,
  calls bigint,
  input_tokens numeric,
  output_tokens numeric,
  cached_tokens numeric,
  cache_write_tokens numeric,
  priced_calls bigint,
  priced_cost_usd numeric,
  priced_sell_inr numeric,
  unpriced_input_tokens numeric,
  unpriced_output_tokens numeric,
  unpriced_cached_tokens numeric,
  unpriced_cache_write_tokens numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.provider_slug,
    l.model_id,
    count(*)::bigint,
    coalesce(sum(l.input_tokens), 0),
    coalesce(sum(l.output_tokens), 0),
    coalesce(sum(l.cached_tokens), 0),
    coalesce(sum(l.cache_write_tokens), 0),
    count(*) filter (where l.priced)::bigint,
    coalesce(sum(l.cost_usd) filter (where l.priced), 0),
    coalesce(sum(l.sell_inr) filter (where l.priced), 0),
    coalesce(sum(l.input_tokens) filter (where not l.priced), 0),
    coalesce(sum(l.output_tokens) filter (where not l.priced), 0),
    coalesce(sum(l.cached_tokens) filter (where not l.priced), 0),
    coalesce(sum(l.cache_write_tokens) filter (where not l.priced), 0)
  from public.token_ledger l
  where l.created_at >= since and l.created_at < until
  group by l.provider_slug, l.model_id
$$;

revoke all on function public.finance_model_usage(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.finance_model_usage(timestamptz, timestamptz) to service_role;

-- Bug fix: chat/index.ts and the generate_image tool record "image_generation" usage events, but the
-- check constraint (0013) never allowed that type — every insert failed and was only logged, so image
-- usage (a real per-image cost) was invisible to usage meters and to the books.
alter table public.usage_events drop constraint if exists usage_events_event_type_check;
alter table public.usage_events
  add constraint usage_events_event_type_check
  check (event_type in (
    'chat_message',
    'web_search',
    'voice_second',
    'sandbox_run',
    'attachment_upload',
    'token_usage',
    'image_generation'
  ));
