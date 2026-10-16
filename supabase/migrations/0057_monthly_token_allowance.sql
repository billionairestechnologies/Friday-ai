-- ─────────────────────────────────────────────────────────────────────────
-- Monthly token allowance + durable usage ledger.
--
-- Replaces the Redis 5-hour / weekly / calendar-month credit windows with ONE allowance per
-- subscription period (monthly, anchored to when the subscription started — the 17th to the 17th,
-- clamped at month end), enforced in Postgres:
--
--   quota_accounts       one row per individual user or enterprise organization: plan, allowance,
--                        current period, finalized usage, net adjustments, active reservations.
--   quota_reservations   a hold taken BEFORE a model is called; settled when the turn ends.
--   token_ledger         (existing) now the append-only usage-event log: one row per metered model
--                        invocation, unique idempotency_key, billable_tokens = what the allowance pays.
--   quota_adjustments    append-only corrections, refunds, bonuses, resets.
--   quota_member_usage   per-member usage inside an enterprise pool (for admin-set member caps).
--   subscription_events  idempotent plan lifecycle log (payments, renewals, upgrades, expiries…).
--
-- The balance rule (the only one — backend/src/services/quota/allowance.ts documents it too):
--   used        = Σ token_ledger.billable_tokens   for the account's current period
--   adjustments = Σ quota_adjustments.tokens       for the account's current period
--   remaining   = allowance − used − adjustments − reserved
-- quota_accounts.used / adjustments / reserved are maintained in the SAME transaction as each
-- ledger/adjustment insert; quota_audit() recomputes them from the logs to prove they agree.
--
-- Every function below locks the account row (SELECT … FOR UPDATE) before reading the balance, so
-- two requests on two servers can never both spend the last tokens. Lock order is always
-- profile → account → reservation → member row.
--
-- Paid terms are counted in calendar MONTHS (1 or 12), never "30 days": a term then ends exactly
-- where an allowance period ends, so no short extra period with a fresh allowance appears in
-- between. Any period a term still cuts short (an upgrade's credited days, an older term) gets a
-- proportional allowance (quota_sync_locked).
--
-- Migration policy (decided by the owner, 2026-10-17): every paid individual and enterprise org
-- starts a FRESH monthly period at deploy time with its full allowance; a paid term ending within a
-- month is extended to deploy + 1 month, a longer one keeps its end date and its periods are
-- aligned to it. A lower plan booked under v3 (profiles.scheduled_plan, 0054) becomes the account's
-- queued plan; 0058 then drops those columns. Historic
-- token_ledger rows are kept untouched (account_id stays null on them — they never count against
-- a new-style period). Personal caps and pools were stored in credits (0046); they are converted
-- once into billable tokens relative to the plan they were sized against (see below).
--
-- Rollback: docs/operations/MONTHLY_ALLOWANCE.md. Runs safely twice. RLS on, no policies: backend only.
-- ─────────────────────────────────────────────────────────────────────────

-- ── Tables ───────────────────────────────────────────────────────────────

create table if not exists public.quota_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references public.profiles (id) on delete cascade,
  organization_id uuid unique references public.organizations (id) on delete cascade,
  plan text not null default 'free',
  allowance bigint not null default 0 check (allowance >= 0),
  -- Periods are period_anchor + n months (UTC, clamped at month end: Jan 31 → Feb 28/29 → Mar 31).
  period_anchor timestamptz not null default now(),
  period_index int not null default 0,
  period_start timestamptz not null default now(),
  period_end timestamptz not null default (now() + interval '1 month'),
  used bigint not null default 0,
  adjustments bigint not null default 0,
  reserved bigint not null default 0 check (reserved >= 0),
  status text not null default 'active' check (status in ('active', 'suspended')),
  -- A cheaper plan bought while a pricier one is still running starts when the current term ends.
  pending_plan text,
  pending_months int,
  -- Highest usage notice (80/95/100 %) already sent for the current period.
  notified_threshold int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((user_id is null) <> (organization_id is null))
);
alter table public.quota_accounts enable row level security;
-- No policies: backend only.

create table if not exists public.quota_reservations (
  id uuid primary key,
  account_id uuid not null references public.quota_accounts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  feature text not null default 'chat',
  conversation_id uuid,
  hold bigint not null default 0 check (hold >= 0),
  consumed bigint not null default 0,
  -- The member-usage period the hold was counted in (enterprise member caps only).
  member_period_start timestamptz,
  status text not null default 'active' check (status in ('active', 'settled', 'expired', 'failed')),
  created_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  settled_at timestamptz
);
alter table public.quota_reservations enable row level security;
-- No policies: backend only.
create index if not exists quota_reservations_active_idx on public.quota_reservations (status, heartbeat_at) where status = 'active';
create index if not exists quota_reservations_account_idx on public.quota_reservations (account_id, created_at desc);

create table if not exists public.quota_adjustments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.quota_accounts (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  period_start timestamptz not null,
  -- Positive consumes allowance, negative gives it back (bonus, refund, reset).
  tokens bigint not null,
  kind text not null check (kind in ('bonus', 'reset', 'refund', 'correction', 'debit', 'migration')),
  reason text not null default '',
  actor_id uuid,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
alter table public.quota_adjustments enable row level security;
-- No policies: backend only.
create index if not exists quota_adjustments_account_idx on public.quota_adjustments (account_id, period_start);

create table if not exists public.quota_member_usage (
  account_id uuid not null references public.quota_accounts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  period_start timestamptz not null,
  used bigint not null default 0,
  reserved bigint not null default 0 check (reserved >= 0),
  primary key (account_id, user_id, period_start)
);
alter table public.quota_member_usage enable row level security;
-- No policies: backend only.

create table if not exists public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete set null,
  organization_id uuid references public.organizations (id) on delete set null,
  kind text not null,
  plan text,
  order_id text,
  idempotency_key text not null unique,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.subscription_events enable row level security;
-- No policies: backend only.
create index if not exists subscription_events_user_idx on public.subscription_events (user_id, created_at desc);
create index if not exists subscription_events_kind_idx on public.subscription_events (kind, created_at desc);

-- token_ledger becomes the usage-event log. Old rows keep nulls (they predate periods).
alter table public.token_ledger
  add column if not exists account_id uuid references public.quota_accounts (id) on delete set null,
  add column if not exists reservation_id uuid,
  add column if not exists period_start timestamptz,
  add column if not exists idempotency_key text,
  add column if not exists billable_tokens bigint,
  add column if not exists reasoning_tokens bigint not null default 0,
  add column if not exists overrun_tokens bigint not null default 0,
  -- provider = the upstream reported it; estimated = derived from text length (flagged for review); none = no tokens consumed.
  add column if not exists usage_source text,
  -- ok | partial (cut short after output began) | failed | aborted (client went away)
  add column if not exists call_status text,
  add column if not exists conversation_id uuid,
  add column if not exists request_id text,
  add column if not exists attempt int,
  add column if not exists streaming boolean,
  add column if not exists latency_ms int,
  add column if not exists meter_version text;
create unique index if not exists token_ledger_idempotency_idx on public.token_ledger (idempotency_key) where idempotency_key is not null;
create index if not exists token_ledger_account_period_idx on public.token_ledger (account_id, period_start) where account_id is not null;
create index if not exists token_ledger_estimated_idx on public.token_ledger (created_at desc) where usage_source = 'estimated';

-- ── Period math ──────────────────────────────────────────────────────────

-- anchor + n calendar months in UTC. timestamp + interval clamps the day (Jan 31 + 1 month = Feb 28/29),
-- and because every period is computed from the ANCHOR (never from the previous period's end),
-- a subscription started on the 31st returns to the 31st in months that have one.
create or replace function public.quota_add_months(p_anchor timestamptz, p_n int)
returns timestamptz language sql immutable as $$
  select ((p_anchor at time zone 'UTC') + make_interval(months => p_n)) at time zone 'UTC'
$$;

-- The n for which quota_add_months(anchor, n) <= now < quota_add_months(anchor, n + 1).
create or replace function public.quota_period_index(p_anchor timestamptz, p_now timestamptz)
returns int language plpgsql immutable as $$
declare
  a timestamp := p_anchor at time zone 'UTC';
  t timestamp := p_now at time zone 'UTC';
  n int;
begin
  if t < a then return 0; end if;
  n := (extract(year from t)::int - extract(year from a)::int) * 12 + (extract(month from t)::int - extract(month from a)::int);
  while n > 0 and a + make_interval(months => n) > t loop n := n - 1; end loop;
  while a + make_interval(months => n + 1) <= t loop n := n + 1; end loop;
  return n;
end $$;

-- The latest `p_end − k months` (k ≥ 1) at or before p_now: anchoring periods there makes the last
-- period of a paid term end exactly when the term does.
create or replace function public.quota_aligned_anchor(p_end timestamptz, p_now timestamptz)
returns timestamptz language sql immutable as $$
  select public.quota_add_months(p_end, -(select min(k) from generate_series(1, 1200) k where public.quota_add_months(p_end, -k) <= p_now))
$$;

create or replace function public.quota_plan_rank(p_plan text)
returns int language sql immutable as $$
  select case p_plan when 'premium' then 2 when 'pro' then 1 else 0 end
$$;

-- ── Account locking + rollover ───────────────────────────────────────────

-- Locks an account and moves it into the period that contains p_now (used/adjustments start at 0
-- in a new period; active holds carry over — they belong to requests still running).
create or replace function public.quota_lock_account_by_id(p_account uuid, p_now timestamptz)
returns public.quota_accounts language plpgsql as $$
declare
  acc public.quota_accounts;
  idx int;
begin
  select * into acc from public.quota_accounts where id = p_account for update;
  if not found then raise exception 'quota account % not found', p_account; end if;
  idx := public.quota_period_index(acc.period_anchor, p_now);
  if idx <> acc.period_index then
    update public.quota_accounts set
      period_index = idx,
      period_start = public.quota_add_months(acc.period_anchor, idx),
      period_end = public.quota_add_months(acc.period_anchor, idx + 1),
      used = 0,
      adjustments = 0,
      notified_threshold = 0,
      updated_at = p_now
    where id = p_account
    returning * into acc;
  end if;
  return acc;
end $$;

create or replace function public.quota_lock_account(p_user uuid, p_org uuid, p_now timestamptz)
returns public.quota_accounts language plpgsql as $$
declare
  acc_id uuid;
  v_anchor timestamptz := p_now;
  v_plan text;
  v_end timestamptz;
begin
  if p_org is not null then
    insert into public.quota_accounts (organization_id, period_anchor, period_start, period_end)
      values (p_org, p_now, p_now, public.quota_add_months(p_now, 1))
      on conflict (organization_id) do nothing;
    select id into acc_id from public.quota_accounts where organization_id = p_org;
  else
    -- A paid term that is already running (set by an admin, a grant or a package) gets periods that
    -- end with it; everyone else starts their first period now.
    if not exists (select 1 from public.quota_accounts where user_id = p_user) then
      select plan, plan_renews_at into v_plan, v_end from public.profiles where id = p_user;
      if v_plan is distinct from 'free' and v_end is not null and v_end > p_now then
        v_anchor := public.quota_aligned_anchor(v_end, p_now);
      end if;
    end if;
    insert into public.quota_accounts (user_id, period_anchor, period_start, period_end)
      values (p_user, v_anchor, v_anchor, public.quota_add_months(v_anchor, 1))
      on conflict (user_id) do nothing;
    select id into acc_id from public.quota_accounts where user_id = p_user;
  end if;
  return public.quota_lock_account_by_id(acc_id, p_now);
end $$;

-- Starts a brand-new period series at p_anchor (new subscription, upgrade, expiry to Free).
create or replace function public.quota_restart_period(p_account uuid, p_anchor timestamptz, p_now timestamptz)
returns void language plpgsql as $$
declare
  idx int := public.quota_period_index(p_anchor, p_now);
begin
  update public.quota_accounts set
    period_anchor = p_anchor,
    period_index = idx,
    period_start = public.quota_add_months(p_anchor, idx),
    period_end = public.quota_add_months(p_anchor, idx + 1),
    used = 0,
    adjustments = 0,
    notified_threshold = 0,
    updated_at = p_now
  where id = p_account;
end $$;

-- ── Subscription lifecycle ───────────────────────────────────────────────

-- Applies a lapsed paid term: a queued downgrade starts, otherwise the person drops to Free. The
-- new period starts at the moment the old term ended, never at "now", so a late request can't
-- stretch the paid term. Idempotent (keyed on the term's end).
create or replace function public.quota_expire_due(p_user uuid, p_now timestamptz)
returns void language plpgsql as $$
declare
  prof record;
  acc public.quota_accounts;
  old_end timestamptz;
  guard int := 0;
begin
  loop
    guard := guard + 1;
    exit when guard > 4;
    select plan, plan_renews_at into prof from public.profiles where id = p_user for update;
    if not found or prof.plan = 'free' or prof.plan_renews_at is null or prof.plan_renews_at > p_now then
      return;
    end if;
    old_end := prof.plan_renews_at;
    acc := public.quota_lock_account(p_user, null, p_now);
    if acc.pending_plan is not null and acc.pending_months is not null then
      update public.profiles set plan = acc.pending_plan, plan_renews_at = public.quota_add_months(old_end, acc.pending_months) where id = p_user;
      update public.quota_accounts set pending_plan = null, pending_months = null where id = acc.id;
      perform public.quota_restart_period(acc.id, old_end, p_now);
      insert into public.subscription_events (user_id, kind, plan, idempotency_key, details)
        values (p_user, 'downgrade_applied', acc.pending_plan, 'downgrade:' || p_user || ':' || old_end, jsonb_build_object('from', prof.plan, 'at', old_end))
        on conflict (idempotency_key) do nothing;
    else
      update public.profiles set plan = 'free', plan_renews_at = null where id = p_user;
      perform public.quota_restart_period(acc.id, old_end, p_now);
      insert into public.subscription_events (user_id, kind, plan, idempotency_key, details)
        values (p_user, 'expired', 'free', 'expired:' || p_user || ':' || old_end, jsonb_build_object('from', prof.plan, 'at', old_end))
        on conflict (idempotency_key) do nothing;
    end if;
  end loop;
end $$;

-- A verified payment for an individual plan (p_months = 1 monthly, 12 annual). Exactly once per
-- order (subscription_events key):
--   same plan, still running   → renewal: the term is extended by p_months from its current end; the
--                                running period is untouched (its allowance is not granted twice).
--   from Free                  → new term starting now with a fresh period and the full allowance.
--   higher plan (upgrade)      → new term starting now, fresh period; the old plan's unused time is
--                                credited at the price ratio (p_prices: {"pro": paise, "premium": paise})
--                                and added to the end of the new term.
--   lower plan while running   → queued: starts when the current term ends.
create or replace function public.quota_apply_payment(
  p_user uuid, p_plan text, p_months int, p_order text, p_now timestamptz default now(), p_prices jsonb default null
) returns jsonb language plpgsql as $$
declare
  ev_id uuid;
  prof record;
  acc public.quota_accounts;
  v_kind text;
  v_credit interval := interval '0';
  v_old_price numeric;
  v_new_price numeric;
begin
  if p_plan not in ('pro', 'premium') then raise exception 'unsupported plan %', p_plan; end if;
  if p_months is null or p_months <= 0 then raise exception 'months must be positive'; end if;
  insert into public.subscription_events (user_id, kind, plan, order_id, idempotency_key, details)
    values (p_user, 'payment', p_plan, p_order, 'payment:' || p_order, jsonb_build_object('months', p_months))
    on conflict (idempotency_key) do nothing
    returning id into ev_id;
  if ev_id is null then
    return jsonb_build_object('applied', false, 'duplicate', true);
  end if;

  perform public.quota_expire_due(p_user, p_now);
  select plan, plan_renews_at into prof from public.profiles where id = p_user for update;
  acc := public.quota_lock_account(p_user, null, p_now);

  if prof.plan = p_plan then
    if prof.plan_renews_at is not null then
      update public.profiles set plan_renews_at = public.quota_add_months(greatest(prof.plan_renews_at, p_now), p_months) where id = p_user;
    end if;
    v_kind := 'renewal';
  elsif public.quota_plan_rank(p_plan) > public.quota_plan_rank(prof.plan) then
    if prof.plan <> 'free' and prof.plan_renews_at is not null and prof.plan_renews_at > p_now then
      v_old_price := nullif((p_prices ->> prof.plan)::numeric, 0);
      v_new_price := nullif((p_prices ->> p_plan)::numeric, 0);
      if v_old_price is not null and v_new_price is not null then
        v_credit := (prof.plan_renews_at - p_now) * (v_old_price / v_new_price)::double precision;
      end if;
    end if;
    update public.profiles set plan = p_plan, plan_renews_at = public.quota_add_months(p_now, p_months) + v_credit where id = p_user;
    update public.quota_accounts set pending_plan = null, pending_months = null where id = acc.id;
    perform public.quota_restart_period(acc.id, p_now, p_now);
    v_kind := case when prof.plan = 'free' then 'subscribe' else 'upgrade' end;
  else
    update public.quota_accounts set
      pending_months = case when pending_plan = p_plan then coalesce(pending_months, 0) + p_months else p_months end,
      pending_plan = p_plan
    where id = acc.id;
    v_kind := 'downgrade_queued';
  end if;

  update public.subscription_events set details = details || jsonb_build_object('applied_as', v_kind, 'previous_plan', prof.plan, 'credit', v_credit::text) where id = ev_id;
  return jsonb_build_object('applied', true, 'kind', v_kind, 'credit', v_credit::text);
end $$;

-- A verified enterprise payment (once per order): seats are set, the pool becomes seats × the
-- catalog per-seat allowance, and the org starts a fresh period with the full pool.
create or replace function public.quota_apply_org_payment(p_org uuid, p_user uuid, p_seats int, p_order text, p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  ev_id uuid;
  acc public.quota_accounts;
begin
  insert into public.subscription_events (user_id, organization_id, kind, plan, order_id, idempotency_key, details)
    values (p_user, p_org, 'org_payment', 'enterprise', p_order, 'payment:' || p_order, jsonb_build_object('seats', p_seats))
    on conflict (idempotency_key) do nothing
    returning id into ev_id;
  if ev_id is null then return jsonb_build_object('applied', false, 'duplicate', true); end if;
  update public.organizations set plan = 'enterprise', seat_count = p_seats, pooled_monthly_tokens = null, billing_cycle_anchor = p_now where id = p_org;
  acc := public.quota_lock_account(null, p_org, p_now);
  perform public.quota_restart_period(acc.id, p_now, p_now);
  return jsonb_build_object('applied', true);
end $$;

-- A refunded order takes back the paid months it bought (once per order). If that ends the term,
-- the person is on Free from now. Tokens already used are not reversed.
create or replace function public.quota_apply_refund(p_user uuid, p_plan text, p_months int, p_order text, p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  ev_id uuid;
  prof record;
  acc public.quota_accounts;
  new_end timestamptz;
begin
  insert into public.subscription_events (user_id, kind, plan, order_id, idempotency_key, details)
    values (p_user, 'refund', p_plan, p_order, 'refund:' || p_order, jsonb_build_object('months', p_months))
    on conflict (idempotency_key) do nothing
    returning id into ev_id;
  if ev_id is null then return jsonb_build_object('applied', false, 'duplicate', true); end if;

  select plan, plan_renews_at into prof from public.profiles where id = p_user for update;
  acc := public.quota_lock_account(p_user, null, p_now);
  if acc.pending_plan = p_plan then
    update public.quota_accounts set pending_months = pending_months - p_months where id = acc.id;
    update public.quota_accounts set pending_plan = null, pending_months = null where id = acc.id and pending_months <= 0;
    return jsonb_build_object('applied', true, 'kind', 'pending_reduced');
  end if;
  if prof.plan <> p_plan or prof.plan_renews_at is null then
    return jsonb_build_object('applied', true, 'kind', 'no_active_term');
  end if;
  new_end := public.quota_add_months(prof.plan_renews_at, -p_months);
  if new_end > p_now then
    update public.profiles set plan_renews_at = new_end where id = p_user;
    return jsonb_build_object('applied', true, 'kind', 'term_shortened');
  end if;
  update public.profiles set plan = 'free', plan_renews_at = null where id = p_user;
  update public.quota_accounts set pending_plan = null, pending_months = null where id = acc.id;
  perform public.quota_restart_period(acc.id, p_now, p_now);
  return jsonb_build_object('applied', true, 'kind', 'ended');
end $$;

-- ── Reservation, metering, settlement ────────────────────────────────────

create or replace function public.quota_account_snapshot(acc public.quota_accounts)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'account_id', acc.id,
    'plan', acc.plan,
    'allowance', acc.allowance,
    'used', acc.used,
    'adjustments', acc.adjustments,
    'reserved', acc.reserved,
    'remaining', acc.allowance - acc.used - acc.adjustments - acc.reserved,
    'period_start', acc.period_start,
    'period_end', acc.period_end,
    'status', acc.status
  )
$$;

-- Brings an account up to date and locks it: expires a lapsed paid term, re-derives the plan and
-- allowance, rolls the period. p_allowances: {"free": n, "pro": n, "premium": n,
-- "enterprise_per_seat": n, "enterprise_min_seats": n} — the console-edited catalog merged with the
-- code defaults, passed in so SQL and the Plans page can never disagree.
create or replace function public.quota_sync_locked(p_user uuid, p_org uuid, p_allowances jsonb, p_now timestamptz)
returns public.quota_accounts language plpgsql as $$
declare
  acc public.quota_accounts;
  v_plan text;
  v_cap bigint;
  v_allowance bigint;
  v_seats int;
  v_pool bigint;
  v_term_end timestamptz;
begin
  if p_org is null then
    perform public.quota_expire_due(p_user, p_now);
    select coalesce(plan, 'free'), custom_monthly_cap, plan_renews_at into v_plan, v_cap, v_term_end from public.profiles where id = p_user;
    v_plan := coalesce(v_plan, 'free');
    v_allowance := coalesce(v_cap, (p_allowances ->> v_plan)::bigint, 0);
    acc := public.quota_lock_account(p_user, null, p_now);
    -- A period the paid term ends inside of gets its share of the allowance, not all of it.
    if v_plan <> 'free' and v_term_end is not null and v_term_end > acc.period_start and v_term_end < acc.period_end then
      v_allowance := floor(v_allowance * extract(epoch from (v_term_end - acc.period_start)) / extract(epoch from (acc.period_end - acc.period_start)))::bigint;
    end if;
  else
    select seat_count, pooled_monthly_tokens into v_seats, v_pool from public.organizations where id = p_org;
    v_plan := 'enterprise';
    v_allowance := coalesce(v_pool, greatest(coalesce(v_seats, 0), coalesce((p_allowances ->> 'enterprise_min_seats')::int, 1))::bigint
      * coalesce((p_allowances ->> 'enterprise_per_seat')::bigint, 0));
    acc := public.quota_lock_account(null, p_org, p_now);
  end if;
  if acc.plan is distinct from v_plan or acc.allowance is distinct from v_allowance then
    update public.quota_accounts set plan = v_plan, allowance = v_allowance, updated_at = p_now where id = acc.id returning * into acc;
  end if;
  return acc;
end $$;

-- Read-only view of the balance for dashboards (still applies expiry + rollover so every screen
-- shows the same period). Includes the member's own usage when they are in an enterprise pool.
create or replace function public.quota_sync(p_user uuid, p_org uuid, p_allowances jsonb, p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  acc public.quota_accounts;
  mem public.quota_member_usage;
  v_member_cap bigint;
begin
  acc := public.quota_sync_locked(p_user, p_org, p_allowances, p_now);
  if p_org is not null then
    select custom_monthly_cap into v_member_cap from public.profiles where id = p_user;
    select * into mem from public.quota_member_usage where account_id = acc.id and user_id = p_user and period_start = acc.period_start;
  end if;
  return public.quota_account_snapshot(acc) || jsonb_build_object(
    'pending_plan', acc.pending_plan,
    'pending_months', acc.pending_months,
    'member_cap', v_member_cap,
    'member_used', coalesce(mem.used, 0)
  );
end $$;

-- Sweeps every lapsed paid term (the request path expires lazily too; this keeps dashboards and
-- notifications current for people who aren't using Friday right now).
create or replace function public.quota_expire_all_due(p_now timestamptz default now())
returns int language plpgsql as $$
declare
  uid uuid;
  n int := 0;
begin
  for uid in select id from public.profiles where plan <> 'free' and plan_renews_at is not null and plan_renews_at <= p_now loop
    perform public.quota_expire_due(uid, p_now);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Resolves the plan + allowance (expiring a lapsed term first), locks the account and, when the
-- balance covers p_amount, takes a hold. Replaying the same reservation id is a no-op.
create or replace function public.quota_reserve(
  p_reservation uuid,
  p_user uuid,
  p_org uuid,
  p_amount bigint,
  p_allowances jsonb,
  p_feature text default 'chat',
  p_conversation uuid default null,
  p_now timestamptz default now()
) returns jsonb language plpgsql as $$
declare
  acc public.quota_accounts;
  v_member_cap bigint;
  mem public.quota_member_usage;
  remaining bigint;
begin
  if p_amount is null or p_amount < 0 then raise exception 'amount must be >= 0'; end if;
  if exists (select 1 from public.quota_reservations where id = p_reservation) then
    select * into acc from public.quota_accounts where id = (select account_id from public.quota_reservations where id = p_reservation);
    return public.quota_account_snapshot(acc) || jsonb_build_object('ok', true, 'replayed', true);
  end if;

  acc := public.quota_sync_locked(p_user, p_org, p_allowances, p_now);
  if p_org is not null then
    select custom_monthly_cap into v_member_cap from public.profiles where id = p_user;
  end if;

  if acc.status = 'suspended' then
    return public.quota_account_snapshot(acc) || jsonb_build_object('ok', false, 'reason', 'suspended');
  end if;

  remaining := acc.allowance - acc.used - acc.adjustments - acc.reserved;
  if p_amount > remaining then
    return public.quota_account_snapshot(acc) || jsonb_build_object('ok', false, 'reason', 'exhausted');
  end if;

  if v_member_cap is not null then
    insert into public.quota_member_usage (account_id, user_id, period_start) values (acc.id, p_user, acc.period_start) on conflict do nothing;
    select * into mem from public.quota_member_usage where account_id = acc.id and user_id = p_user and period_start = acc.period_start for update;
    if mem.used + mem.reserved + p_amount > v_member_cap then
      return public.quota_account_snapshot(acc) || jsonb_build_object('ok', false, 'reason', 'member_cap', 'member_used', mem.used, 'member_cap', v_member_cap);
    end if;
    update public.quota_member_usage set reserved = reserved + p_amount where account_id = acc.id and user_id = p_user and period_start = acc.period_start;
  end if;

  insert into public.quota_reservations (id, account_id, user_id, feature, conversation_id, hold, member_period_start, created_at, heartbeat_at)
    values (p_reservation, acc.id, p_user, coalesce(p_feature, 'chat'), p_conversation, p_amount,
      case when v_member_cap is not null then acc.period_start end, p_now, p_now);
  update public.quota_accounts set reserved = reserved + p_amount, updated_at = p_now where id = acc.id returning * into acc;
  return public.quota_account_snapshot(acc) || jsonb_build_object('ok', true, 'member_cap', v_member_cap);
end $$;

-- Grows a running request's hold to p_hold (the real prompt is known now, or the next agent round
-- is about to start). Refused — nothing changes — when the balance can't cover the increase.
create or replace function public.quota_extend_hold(p_reservation uuid, p_hold bigint, p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  r public.quota_reservations;
  acc public.quota_accounts;
  delta bigint;
  remaining bigint;
  v_member_cap bigint;
  mem public.quota_member_usage;
begin
  select * into r from public.quota_reservations where id = p_reservation;
  if not found then raise exception 'reservation % not found', p_reservation; end if;
  acc := public.quota_lock_account_by_id(r.account_id, p_now);
  select * into r from public.quota_reservations where id = p_reservation for update;
  if r.status <> 'active' then
    return public.quota_account_snapshot(acc) || jsonb_build_object('ok', false, 'reason', 'settled');
  end if;
  update public.quota_reservations set heartbeat_at = p_now where id = p_reservation;
  delta := p_hold - r.hold;
  if delta <= 0 then
    return public.quota_account_snapshot(acc) || jsonb_build_object('ok', acc.status = 'active', 'reason', case when acc.status = 'active' then null else acc.status end);
  end if;
  if acc.status = 'suspended' then
    return public.quota_account_snapshot(acc) || jsonb_build_object('ok', false, 'reason', 'suspended');
  end if;
  remaining := acc.allowance - acc.used - acc.adjustments - acc.reserved;
  if delta > remaining then
    return public.quota_account_snapshot(acc) || jsonb_build_object('ok', false, 'reason', 'exhausted');
  end if;
  if r.member_period_start is not null then
    select custom_monthly_cap into v_member_cap from public.profiles where id = r.user_id;
    select * into mem from public.quota_member_usage where account_id = acc.id and user_id = r.user_id and period_start = r.member_period_start for update;
    if v_member_cap is not null and found and mem.used + mem.reserved + delta > v_member_cap then
      return public.quota_account_snapshot(acc) || jsonb_build_object('ok', false, 'reason', 'member_cap');
    end if;
    update public.quota_member_usage set reserved = reserved + delta where account_id = acc.id and user_id = r.user_id and period_start = r.member_period_start;
  end if;
  update public.quota_reservations set hold = p_hold where id = p_reservation;
  update public.quota_accounts set reserved = reserved + delta, updated_at = p_now where id = acc.id returning * into acc;
  return public.quota_account_snapshot(acc) || jsonb_build_object('ok', true);
end $$;

-- Records ONE metered model invocation (or one agent round) exactly once: the ledger row's
-- idempotency_key makes a retried call a no-op. Usage is always recorded in full — even past the
-- balance (the call already happened upstream); the overrun is written on the row and the
-- returned ok=false tells the caller to stop starting new calls.
-- p_event keys: idempotency_key, user_id, organization_id, provider_slug, model_id, input_tokens,
-- output_tokens, total_tokens, cached_tokens, cache_write_tokens, reasoning_tokens, billable_tokens,
-- usage_source, call_status, feature, conversation_id, request_id, attempt, streaming, latency_ms,
-- cost_usd, sell_inr, priced, estimated_cost_cents, meter_version.
create or replace function public.quota_record_usage(p_reservation uuid, p_event jsonb, p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  r public.quota_reservations;
  acc public.quota_accounts;
  v_id uuid;
  v_billable bigint := greatest(0, coalesce((p_event ->> 'billable_tokens')::bigint, 0));
  v_release bigint := 0;
  remaining bigint;
  v_overrun bigint := 0;
  pct int;
  crossed int := 0;
begin
  if coalesce(p_event ->> 'idempotency_key', '') = '' then raise exception 'idempotency_key is required'; end if;
  select * into r from public.quota_reservations where id = p_reservation;
  if not found then raise exception 'reservation % not found', p_reservation; end if;
  acc := public.quota_lock_account_by_id(r.account_id, p_now);
  select * into r from public.quota_reservations where id = p_reservation for update;

  insert into public.token_ledger (
    user_id, organization_id, provider_slug, model_id, input_tokens, output_tokens, total_tokens,
    cached_tokens, cache_write_tokens, reasoning_tokens, billable_tokens, estimated_cost_cents, reserved_tokens,
    cost_usd, sell_inr, priced, feature, account_id, reservation_id, period_start, idempotency_key,
    usage_source, call_status, conversation_id, request_id, attempt, streaming, latency_ms, meter_version, created_at
  ) values (
    r.user_id,
    nullif(p_event ->> 'organization_id', '')::uuid,
    coalesce(p_event ->> 'provider_slug', 'unknown'),
    coalesce(p_event ->> 'model_id', 'unknown'),
    greatest(0, coalesce((p_event ->> 'input_tokens')::bigint, 0)),
    greatest(0, coalesce((p_event ->> 'output_tokens')::bigint, 0)),
    greatest(0, coalesce((p_event ->> 'total_tokens')::bigint, 0)),
    greatest(0, coalesce((p_event ->> 'cached_tokens')::bigint, 0)),
    greatest(0, coalesce((p_event ->> 'cache_write_tokens')::bigint, 0)),
    greatest(0, coalesce((p_event ->> 'reasoning_tokens')::bigint, 0)),
    v_billable,
    coalesce((p_event ->> 'estimated_cost_cents')::numeric, 0),
    r.hold,
    (p_event ->> 'cost_usd')::numeric,
    (p_event ->> 'sell_inr')::numeric,
    coalesce((p_event ->> 'priced')::boolean, false),
    coalesce(p_event ->> 'feature', r.feature),
    acc.id,
    r.id,
    acc.period_start,
    p_event ->> 'idempotency_key',
    coalesce(p_event ->> 'usage_source', 'provider'),
    coalesce(p_event ->> 'call_status', 'ok'),
    coalesce(nullif(p_event ->> 'conversation_id', '')::uuid, r.conversation_id),
    p_event ->> 'request_id',
    (p_event ->> 'attempt')::int,
    (p_event ->> 'streaming')::boolean,
    (p_event ->> 'latency_ms')::int,
    coalesce(p_event ->> 'meter_version', 'billable-v1'),
    p_now
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;

  if v_id is null then
    return public.quota_account_snapshot(acc) || jsonb_build_object('ok', acc.allowance - acc.used - acc.adjustments - acc.reserved > 0, 'duplicate', true);
  end if;

  if r.status = 'active' then
    v_release := least(r.hold, v_billable);
  end if;
  update public.quota_reservations set
    consumed = consumed + v_billable,
    hold = hold - v_release,
    heartbeat_at = p_now
  where id = r.id;
  if r.member_period_start is not null then
    update public.quota_member_usage set reserved = greatest(0, reserved - v_release) where account_id = acc.id and user_id = r.user_id and period_start = r.member_period_start;
    insert into public.quota_member_usage (account_id, user_id, period_start, used) values (acc.id, r.user_id, acc.period_start, v_billable)
      on conflict (account_id, user_id, period_start) do update set used = public.quota_member_usage.used + excluded.used;
  end if;
  update public.quota_accounts set
    used = used + v_billable,
    reserved = greatest(0, reserved - v_release),
    updated_at = p_now
  where id = acc.id
  returning * into acc;

  remaining := acc.allowance - acc.used - acc.adjustments - acc.reserved;
  if remaining < 0 then
    v_overrun := least(v_billable, -remaining);
    update public.token_ledger set overrun_tokens = v_overrun where id = v_id;
  end if;

  -- Usage notices: report the highest newly crossed threshold once per period.
  if acc.allowance > 0 then
    pct := floor(((acc.used + acc.adjustments)::numeric / acc.allowance) * 100);
    crossed := case when pct >= 100 then 100 when pct >= 95 then 95 when pct >= 80 then 80 else 0 end;
    if crossed > acc.notified_threshold then
      update public.quota_accounts set notified_threshold = crossed where id = acc.id;
    else
      crossed := 0;
    end if;
  end if;

  return public.quota_account_snapshot(acc) || jsonb_build_object('ok', remaining > 0, 'ledger_id', v_id, 'overrun', v_overrun, 'crossed', crossed);
end $$;

-- Ends a request: whatever hold is left goes back to the balance. Idempotent (only an active
-- reservation is settled; a second call returns settled=false).
create or replace function public.quota_settle(p_reservation uuid, p_status text default 'settled', p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  r public.quota_reservations;
  acc public.quota_accounts;
begin
  if p_status not in ('settled', 'expired', 'failed') then raise exception 'bad status %', p_status; end if;
  select * into r from public.quota_reservations where id = p_reservation;
  if not found then return jsonb_build_object('settled', false, 'reason', 'not_found'); end if;
  acc := public.quota_lock_account_by_id(r.account_id, p_now);
  select * into r from public.quota_reservations where id = p_reservation for update;
  if r.status <> 'active' then
    return public.quota_account_snapshot(acc) || jsonb_build_object('settled', false, 'status', r.status);
  end if;
  if r.member_period_start is not null then
    update public.quota_member_usage set reserved = greatest(0, reserved - r.hold) where account_id = acc.id and user_id = r.user_id and period_start = r.member_period_start;
  end if;
  update public.quota_reservations set hold = 0, status = p_status, settled_at = p_now where id = r.id;
  update public.quota_accounts set reserved = greatest(0, reserved - r.hold), updated_at = p_now where id = acc.id returning * into acc;
  return public.quota_account_snapshot(acc) || jsonb_build_object('settled', true, 'released', r.hold, 'consumed', r.consumed);
end $$;

-- Releases holds whose request stopped reporting (server crash mid-turn). A live request records
-- usage — and with it a heartbeat — every model round, and no turn runs longer than ~40 minutes, so
-- the idle threshold the backend passes (2 hours) can't catch a request that is still running.
create or replace function public.quota_expire_stale_reservations(p_idle interval, p_now timestamptz default now())
returns int language plpgsql as $$
declare
  rid uuid;
  n int := 0;
begin
  for rid in select id from public.quota_reservations where status = 'active' and heartbeat_at < p_now - p_idle loop
    perform public.quota_settle(rid, 'expired', p_now);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Append-only correction / bonus / reset / refund. Positive tokens consume allowance, negative give
-- it back. Exactly once per idempotency key.
create or replace function public.quota_adjust(
  p_account uuid, p_tokens bigint, p_kind text, p_reason text, p_actor uuid, p_key text, p_now timestamptz default now()
) returns jsonb language plpgsql as $$
declare
  acc public.quota_accounts;
  v_id uuid;
begin
  acc := public.quota_lock_account_by_id(p_account, p_now);
  insert into public.quota_adjustments (account_id, user_id, period_start, tokens, kind, reason, actor_id, idempotency_key, created_at)
    values (acc.id, acc.user_id, acc.period_start, p_tokens, p_kind, coalesce(p_reason, ''), p_actor, p_key, p_now)
    on conflict (idempotency_key) do nothing
    returning id into v_id;
  if v_id is null then
    return public.quota_account_snapshot(acc) || jsonb_build_object('applied', false, 'duplicate', true);
  end if;
  update public.quota_accounts set adjustments = adjustments + p_tokens, updated_at = p_now where id = acc.id returning * into acc;
  return public.quota_account_snapshot(acc) || jsonb_build_object('applied', true);
end $$;

-- Recomputes every account's current-period figures from the logs and returns the ones that
-- disagree with the maintained balance (should always be empty; anything here is a bug to fix).
create or replace function public.quota_audit()
returns table (account_id uuid, field text, stored bigint, computed bigint)
language sql stable as $$
  with a as (select * from public.quota_accounts),
  l as (
    select a.id, coalesce(sum(t.billable_tokens), 0)::bigint as total
    from a left join public.token_ledger t on t.account_id = a.id and t.period_start = a.period_start
    group by a.id
  ),
  j as (
    select a.id, coalesce(sum(q.tokens), 0)::bigint as total
    from a left join public.quota_adjustments q on q.account_id = a.id and q.period_start = a.period_start
    group by a.id
  ),
  h as (
    select a.id, coalesce(sum(r.hold), 0)::bigint as total
    from a left join public.quota_reservations r on r.account_id = a.id and r.status = 'active'
    group by a.id
  )
  select a.id, 'used', a.used, l.total from a join l on l.id = a.id where a.used <> l.total
  union all
  select a.id, 'adjustments', a.adjustments, j.total from a join j on j.id = a.id where a.adjustments <> j.total
  union all
  select a.id, 'reserved', a.reserved, h.total from a join h on h.id = a.id where a.reserved <> h.total
$$;

-- Alert inputs for the maintenance job (backend/src/services/quota/quotaJobs.ts).
-- Spikes: accounts that spent more than p_share of their allowance since p_since (not blocked —
-- spending it all in a day is allowed — just worth a look). Overspent: accounts whose period usage
-- is past the allowance by more than p_tolerance (an in-flight call may overrun a little; more than
-- that means something got around the reservation).
create or replace function public.quota_spikes(p_since timestamptz, p_share numeric)
returns table (account_id uuid, billable bigint, allowance bigint)
language sql stable as $$
  select a.id, sum(t.billable_tokens)::bigint, a.allowance
  from public.token_ledger t join public.quota_accounts a on a.id = t.account_id
  where t.created_at >= p_since
  group by a.id, a.allowance
  having a.allowance > 0 and sum(t.billable_tokens) > a.allowance * p_share
$$;

create or replace function public.quota_overspent(p_tolerance numeric)
returns table (account_id uuid, consumed bigint, allowance bigint)
language sql stable as $$
  select id, used + adjustments, allowance from public.quota_accounts
  where allowance > 0 and used + adjustments > allowance * (1 + p_tolerance)
$$;

-- Dashboard breakdown of one period from the ledger (p_user null = the whole account, e.g. an org pool).
create or replace function public.quota_usage_report(p_account uuid, p_user uuid, p_period timestamptz)
returns jsonb language sql stable as $$
  with rows as (
    select * from public.token_ledger
    where account_id = p_account and period_start = p_period and (p_user is null or user_id = p_user)
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
      'calls', count(*),
      'billable', coalesce(sum(billable_tokens), 0),
      'input', coalesce(sum(input_tokens), 0),
      'output', coalesce(sum(output_tokens), 0),
      'cached', coalesce(sum(cached_tokens), 0),
      'reasoning', coalesce(sum(reasoning_tokens), 0),
      'estimated_billable', coalesce(sum(billable_tokens) filter (where usage_source = 'estimated'), 0)
    ) from rows),
    'by_model', coalesce((select jsonb_agg(m order by m.billable desc) from (
      select provider_slug, model_id, count(*) as calls, sum(billable_tokens) as billable, sum(input_tokens) as input,
        sum(output_tokens) as output, sum(cached_tokens) as cached, sum(reasoning_tokens) as reasoning,
        sum(billable_tokens) filter (where usage_source = 'estimated') as estimated_billable
      from rows group by provider_slug, model_id
    ) m), '[]'::jsonb),
    'by_feature', coalesce((select jsonb_agg(f order by f.billable desc) from (
      select coalesce(feature, 'chat') as feature, count(*) as calls, sum(billable_tokens) as billable
      from rows group by coalesce(feature, 'chat')
    ) f), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(d order by d.day) from (
      select (created_at at time zone 'UTC')::date as day, sum(billable_tokens) as billable
      from rows group by 1
    ) d), '[]'::jsonb)
  )
$$;

-- ── Functions are backend-only (PostgREST would otherwise expose them to anon) ──

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'quota_lock_account_by_id(uuid, timestamptz)', 'quota_lock_account(uuid, uuid, timestamptz)',
    'quota_restart_period(uuid, timestamptz, timestamptz)', 'quota_expire_due(uuid, timestamptz)',
    'quota_apply_payment(uuid, text, int, text, timestamptz, jsonb)', 'quota_apply_refund(uuid, text, int, text, timestamptz)',
    'quota_apply_org_payment(uuid, uuid, int, text, timestamptz)',
    'quota_sync_locked(uuid, uuid, jsonb, timestamptz)', 'quota_sync(uuid, uuid, jsonb, timestamptz)',
    'quota_expire_all_due(timestamptz)', 'quota_add_months(timestamptz, int)', 'quota_period_index(timestamptz, timestamptz)',
    'quota_aligned_anchor(timestamptz, timestamptz)',
    'quota_plan_rank(text)', 'quota_account_snapshot(public.quota_accounts)',
    'quota_reserve(uuid, uuid, uuid, bigint, jsonb, text, uuid, timestamptz)', 'quota_extend_hold(uuid, bigint, timestamptz)',
    'quota_record_usage(uuid, jsonb, timestamptz)', 'quota_settle(uuid, text, timestamptz)',
    'quota_expire_stale_reservations(interval, timestamptz)', 'quota_adjust(uuid, bigint, text, text, uuid, text, timestamptz)',
    'quota_audit()', 'quota_usage_report(uuid, uuid, timestamptz)',
    'quota_spikes(timestamptz, numeric)', 'quota_overspent(numeric)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%s from authenticated', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', fn); end if;
  end loop;
end $$;

-- ── One-time data migration (marker: meter_unit, created by 0046) ─────────

create table if not exists public.meter_unit (
  id boolean primary key default true check (id),
  unit text not null,
  converted_at timestamptz not null default now()
);
alter table public.meter_unit enable row level security;

do $$
begin
  if exists (select 1 from public.meter_unit where unit = 'billable_tokens') then
    return;
  end if;

  -- Plan allowances (billable tokens per monthly period). The window columns are retired.
  update public.plan_catalog set weekly_tokens = null, rolling_tokens = null;
  update public.plan_catalog set monthly_tokens = 1000000 where id = 'free';
  update public.plan_catalog set monthly_tokens = 10000000 where id = 'pro';
  update public.plan_catalog set monthly_tokens = 25000000 where id = 'premium';
  update public.plan_catalog set tokens_per_seat = 30000000, monthly_tokens = null where id = 'enterprise';
  update public.plan_catalog set features = array_replace(features, 'Light daily usage, refreshed every 5 hours and weekly', '1M tokens every month') where id = 'free';
  update public.plan_catalog set features = array_replace(features, 'Generous usage every 5 hours, week and month', '10M tokens every month, use them whenever you like') where id = 'pro';
  update public.plan_catalog set features = array_replace(features, 'About 2x Pro''s usage, the most for one person', '25M tokens every month, the most for one person') where id = 'premium';
  update public.plan_catalog set features = array_replace(features, 'Org-pooled monthly usage, no 5-hour lockout', '30M tokens per seat each month, pooled across your team') where id = 'enterprise';

  -- Credits → billable tokens, relative to the plan each figure was sized against (so a package
  -- built as "2x Pro" stays 2x Pro): individual caps × (10M / Pro's old 450,000-credit month),
  -- pools × (30M / the old 1,000,000-credit seat). Pools that were just seats × the old per-seat
  -- default become null, i.e. "seats × the catalog per-seat allowance".
  if exists (select 1 from public.meter_unit where unit = 'credits') then
    update public.profiles set custom_monthly_cap = round(custom_monthly_cap * (10000000.0 / 450000.0) / 1000) * 1000
      where custom_monthly_cap is not null and custom_monthly_cap > 0;
    update public.organizations set pooled_monthly_tokens = null
      where pooled_monthly_tokens is not null and pooled_monthly_tokens = greatest(seat_count, 3)::bigint * 1000000;
    update public.organizations set pooled_monthly_tokens = pooled_monthly_tokens * 30
      where pooled_monthly_tokens is not null;
    update public.plan_packages set
      monthly_token_cap = case when monthly_token_cap is null then null else round(monthly_token_cap * (10000000.0 / 450000.0) / 1000) * 1000 end,
      pooled_monthly_tokens = case when pooled_monthly_tokens is null then null else pooled_monthly_tokens * 30 end;
    update public.access_grants set
      monthly_token_cap = case when monthly_token_cap is null then null else round(monthly_token_cap * (10000000.0 / 450000.0) / 1000) * 1000 end,
      pooled_monthly_tokens = case when pooled_monthly_tokens is null then null else pooled_monthly_tokens * 30 end;
  end if;

  -- Fresh period at deploy for every paid individual. A term ending within a month is extended to
  -- deploy + 1 month (periods anchored at deploy); a longer term keeps its end, and its periods are
  -- anchored so the last one ends exactly with it (anchor = end − n months, the latest such ≤ now).
  update public.profiles set plan_renews_at = public.quota_add_months(now(), 1)
    where plan in ('pro', 'premium') and plan_renews_at is not null and plan_renews_at < public.quota_add_months(now(), 1);
  insert into public.quota_accounts (user_id, plan, period_anchor, period_start, period_end)
    select p.id, p.plan, a.anchor, a.anchor, public.quota_add_months(a.anchor, 1)
    from public.profiles p
    cross join lateral (
      select case
        when p.plan_renews_at is null or p.plan_renews_at <= public.quota_add_months(now(), 1) then now()
        else public.quota_aligned_anchor(p.plan_renews_at, now())
      end as anchor
    ) a
    where p.plan in ('pro', 'premium')
    on conflict (user_id) do nothing;
  -- v3 (0054) booked lower plans on the profile; they become the account's queued plan.
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'scheduled_plan') then
    execute $q$
      update public.quota_accounts a set
        pending_plan = p.scheduled_plan,
        pending_months = greatest(1, round(coalesce(p.scheduled_plan_days, 30) / 30.0))::int
      from public.profiles p
      where a.user_id = p.id and p.scheduled_plan in ('pro', 'premium') and p.plan in ('pro', 'premium')
    $q$;
  end if;
  insert into public.quota_accounts (organization_id, plan, period_anchor, period_start, period_end)
    select id, 'enterprise', now(), now(), public.quota_add_months(now(), 1) from public.organizations where plan = 'enterprise'
    on conflict (organization_id) do nothing;
  insert into public.subscription_events (user_id, kind, plan, idempotency_key, details)
    select id, 'migration', plan, 'migration-0057:' || id, jsonb_build_object('plan_renews_at', plan_renews_at)
    from public.profiles where plan in ('pro', 'premium')
    on conflict (idempotency_key) do nothing;

  delete from public.meter_unit;
  insert into public.meter_unit (id, unit) values (true, 'billable_tokens');
end $$;
