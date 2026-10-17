-- 0060 Credit grants with real expiry (docs/product/V3_PROGRAM.md, phase 03b).
--
-- Before: a bonus was a negative quota_adjustment — it lived only until the month rolled over
-- (adjustments reset to 0), so "valid for 90 days" was impossible and unused bonus vanished.
-- Now a bonus is a CREDIT GRANT: its own balance on the account that survives rollovers and
-- expires on its own date.
--
--   quota_credit_grants  append-only grants (tokens, remaining, expiry, status, who/why, approval).
--   quota_credit_draws   which grant paid for which usage (ledger row or adjustment), per period.
--   quota_accounts.credits       = Σ remaining of active grants (spendable now).
--   quota_accounts.credit_drawn  = credits spent in the CURRENT period (Σ draws this period).
--
-- Order of use: the month's plan allowance first, then credits, soonest-expiring grant first. A
-- draw happens when usage is RECORDED (quota_record_usage / quota_adjust) and only re-labels where
-- the tokens came from, so the balance rule is one formula everywhere (quota_remaining):
--
--   remaining = allowance + credit_drawn + credits − used − adjustments − reserved
--
-- (With no grants, credits = credit_drawn = 0 and this is exactly 0057's rule.) Holds can be
-- covered by credits; a grant that expires while held is handled like any overrun.
--
-- Approval: grants flagged requires_approval start 'pending' and change no balance until someone
-- OTHER than their creator approves them. Revoking takes back what's left; what was used stays used.

create table if not exists public.quota_credit_grants (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.quota_accounts (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  organization_id uuid references public.organizations (id) on delete set null,
  tokens bigint not null check (tokens > 0),
  remaining bigint not null check (remaining >= 0),
  status text not null check (status in ('pending', 'active', 'expired', 'revoked', 'rejected')),
  kind text not null check (kind in ('promotional', 'goodwill', 'trial', 'compensation', 'campaign', 'offer', 'program')),
  source text not null default 'console',
  reason text not null check (length(reason) between 3 and 500),
  expires_at timestamptz,
  batch_id uuid,
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  revoke_reason text,
  expired_tokens bigint not null default 0,
  revoked_tokens bigint not null default 0,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  check (remaining <= tokens)
);
-- No policies: backend only
alter table public.quota_credit_grants enable row level security;
create index if not exists quota_credit_grants_account_idx on public.quota_credit_grants (account_id, status, expires_at);
create index if not exists quota_credit_grants_batch_idx on public.quota_credit_grants (batch_id) where batch_id is not null;
create index if not exists quota_credit_grants_pending_idx on public.quota_credit_grants (created_at) where status = 'pending';

create table if not exists public.quota_credit_draws (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references public.quota_credit_grants (id) on delete cascade,
  account_id uuid not null references public.quota_accounts (id) on delete cascade,
  period_start timestamptz not null,
  tokens bigint not null check (tokens > 0),
  ledger_id uuid,
  adjustment_id uuid,
  created_at timestamptz not null default now()
);
-- No policies: backend only
alter table public.quota_credit_draws enable row level security;
create index if not exists quota_credit_draws_account_idx on public.quota_credit_draws (account_id, period_start);

alter table public.quota_accounts
  add column if not exists credits bigint not null default 0,
  add column if not exists credit_drawn bigint not null default 0;
do $$ begin
  alter table public.quota_accounts add constraint quota_accounts_credits_check check (credits >= 0 and credit_drawn >= 0);
exception when duplicate_object then null; end $$;

-- Grant limits the console enforces (single row). Grants above approval_threshold_tokens (one
-- grant, or a bulk batch's total) need a second person's approval.
create table if not exists public.credit_settings (
  id boolean primary key default true check (id),
  approval_threshold_tokens bigint not null default 10000000 check (approval_threshold_tokens > 0),
  max_grant_tokens bigint not null default 1000000000 check (max_grant_tokens > 0),
  bulk_max_recipients int not null default 5000 check (bulk_max_recipients > 0),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
-- No policies: backend only
alter table public.credit_settings enable row level security;
insert into public.credit_settings (id) values (true) on conflict do nothing;

-- In-app notifications for one user (benefit granted, …). Written only AFTER the thing they announce
-- has committed. Phase 05 renders them as one-time popups + an inbox; push goes out right away.
create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  data jsonb not null default '{}'::jsonb,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  acknowledged_at timestamptz
);
-- No policies: backend only
alter table public.user_notifications enable row level security;
create index if not exists user_notifications_user_idx on public.user_notifications (user_id, created_at desc);

-- The one balance rule.
create or replace function public.quota_remaining(acc public.quota_accounts)
returns bigint language sql immutable as $$
  select acc.allowance + acc.credit_drawn + acc.credits - acc.used - acc.adjustments - acc.reserved
$$;

-- Expires grants whose date has passed (called with the account locked, from quota_lock_account_by_id).
create or replace function public.quota_expire_credits(acc public.quota_accounts, p_now timestamptz)
returns public.quota_accounts language plpgsql as $$
declare
  v_total bigint;
begin
  with gone as (
    update public.quota_credit_grants set status = 'expired', expired_tokens = remaining, remaining = 0
    where account_id = acc.id and status = 'active' and expires_at is not null and expires_at <= p_now
    returning expired_tokens
  )
  select coalesce(sum(expired_tokens), 0) into v_total from gone;
  if v_total > 0 then
    update public.quota_accounts set credits = credits - v_total, updated_at = p_now where id = acc.id returning * into acc;
  end if;
  return acc;
end $$;

-- Pays this period's overflow past the allowance from credits (soonest expiry first, then oldest).
-- Called with the account locked, after used/adjustments changed. Never draws more than exists.
create or replace function public.quota_draw_credits(acc public.quota_accounts, p_ledger uuid, p_adjustment uuid, p_now timestamptz)
returns public.quota_accounts language plpgsql as $$
declare
  need bigint := least(acc.used + acc.adjustments - acc.allowance - acc.credit_drawn, acc.credits);
  g record;
  take bigint;
  v_total bigint := 0;
begin
  if need <= 0 then return acc; end if;
  for g in
    select id, remaining from public.quota_credit_grants
    where account_id = acc.id and status = 'active' and remaining > 0 and (expires_at is null or expires_at > p_now)
    order by expires_at nulls last, created_at, id
    for update
  loop
    exit when need <= 0;
    take := least(need, g.remaining);
    update public.quota_credit_grants set remaining = remaining - take where id = g.id;
    insert into public.quota_credit_draws (grant_id, account_id, period_start, tokens, ledger_id, adjustment_id, created_at)
      values (g.id, acc.id, acc.period_start, take, p_ledger, p_adjustment, p_now);
    need := need - take;
    v_total := v_total + take;
  end loop;
  if v_total > 0 then
    update public.quota_accounts set credits = credits - v_total, credit_drawn = credit_drawn + v_total, updated_at = p_now
      where id = acc.id returning * into acc;
  end if;
  return acc;
end $$;

-- Grants credits to a person (p_user) or an org pool (p_org). Idempotent on p_key: a retried or
-- double-clicked grant returns the first one. p_requires_approval → 'pending', no balance change yet.
create or replace function public.quota_grant_credits(
  p_user uuid, p_org uuid, p_tokens bigint, p_expires_at timestamptz, p_kind text, p_reason text,
  p_actor uuid, p_key text, p_requires_approval boolean default false, p_batch uuid default null,
  p_source text default 'console', p_now timestamptz default now()
) returns jsonb language plpgsql as $$
declare
  acc public.quota_accounts;
  v_id uuid;
  v_existing public.quota_credit_grants;
begin
  if p_tokens is null or p_tokens <= 0 then raise exception 'tokens must be > 0'; end if;
  if p_expires_at is not null and p_expires_at <= p_now then raise exception 'expiry must be in the future'; end if;
  if coalesce(p_key, '') = '' then raise exception 'idempotency key is required'; end if;
  select * into v_existing from public.quota_credit_grants where idempotency_key = p_key;
  if found then
    select * into acc from public.quota_accounts where id = v_existing.account_id;
    return public.quota_account_snapshot(acc) || jsonb_build_object('grant_id', v_existing.id, 'status', v_existing.status, 'duplicate', true);
  end if;
  acc := public.quota_lock_account(p_user, p_org, p_now);
  insert into public.quota_credit_grants (account_id, user_id, organization_id, tokens, remaining, status, kind, source, reason,
      expires_at, batch_id, created_by, idempotency_key, created_at, approved_by, approved_at)
    values (acc.id, acc.user_id, acc.organization_id, p_tokens, p_tokens,
      case when p_requires_approval then 'pending' else 'active' end, p_kind, coalesce(p_source, 'console'), p_reason,
      p_expires_at, p_batch, p_actor, p_key, p_now,
      case when p_requires_approval then null else p_actor end, case when p_requires_approval then null else p_now end)
    on conflict (idempotency_key) do nothing
    returning id into v_id;
  if v_id is null then
    select * into v_existing from public.quota_credit_grants where idempotency_key = p_key;
    return public.quota_account_snapshot(acc) || jsonb_build_object('grant_id', v_existing.id, 'status', v_existing.status, 'duplicate', true);
  end if;
  if not p_requires_approval then
    update public.quota_accounts set credits = credits + p_tokens, updated_at = p_now where id = acc.id returning * into acc;
  end if;
  return public.quota_account_snapshot(acc) || jsonb_build_object('grant_id', v_id, 'status', case when p_requires_approval then 'pending' else 'active' end, 'duplicate', false);
end $$;

-- Approves a pending grant: only someone other than its creator, and only while it hasn't expired.
create or replace function public.quota_approve_credit_grant(p_grant uuid, p_approver uuid, p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  g public.quota_credit_grants;
  acc public.quota_accounts;
begin
  select * into g from public.quota_credit_grants where id = p_grant;
  if not found then raise exception 'grant % not found', p_grant; end if;
  acc := public.quota_lock_account_by_id(g.account_id, p_now);
  select * into g from public.quota_credit_grants where id = p_grant for update;
  if g.status = 'active' then
    return public.quota_account_snapshot(acc) || jsonb_build_object('grant_id', g.id, 'status', g.status, 'duplicate', true);
  end if;
  if g.status <> 'pending' then raise exception 'grant_not_pending'; end if;
  if g.created_by is not null and g.created_by = p_approver then raise exception 'self_approval'; end if;
  if g.expires_at is not null and g.expires_at <= p_now then raise exception 'grant_expired'; end if;
  update public.quota_credit_grants set status = 'active', approved_by = p_approver, approved_at = p_now where id = g.id;
  update public.quota_accounts set credits = credits + g.tokens, updated_at = p_now where id = acc.id returning * into acc;
  return public.quota_account_snapshot(acc) || jsonb_build_object('grant_id', g.id, 'status', 'active', 'duplicate', false);
end $$;

-- Rejects a pending grant, or revokes an active one (what's left is taken back; used stays used).
create or replace function public.quota_revoke_credit_grant(p_grant uuid, p_actor uuid, p_reason text, p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  g public.quota_credit_grants;
  acc public.quota_accounts;
begin
  select * into g from public.quota_credit_grants where id = p_grant;
  if not found then raise exception 'grant % not found', p_grant; end if;
  acc := public.quota_lock_account_by_id(g.account_id, p_now);
  select * into g from public.quota_credit_grants where id = p_grant for update;
  if g.status = 'pending' then
    update public.quota_credit_grants set status = 'rejected', revoked_by = p_actor, revoked_at = p_now, revoke_reason = p_reason where id = g.id;
  elsif g.status = 'active' then
    update public.quota_credit_grants set status = 'revoked', revoked_by = p_actor, revoked_at = p_now, revoke_reason = p_reason,
      revoked_tokens = remaining, remaining = 0 where id = g.id;
    update public.quota_accounts set credits = credits - g.remaining, updated_at = p_now where id = acc.id returning * into acc;
  else
    raise exception 'grant_not_revocable';
  end if;
  return public.quota_account_snapshot(acc) || jsonb_build_object('grant_id', g.id, 'status', case when g.status = 'pending' then 'rejected' else 'revoked' end, 'taken_back', case when g.status = 'active' then g.remaining else 0 end);
end $$;

-- Who a bulk grant reaches (paged by id). Unlike the marketing audience this ignores the marketing
-- opt-out: a benefit isn't marketing. p_kind: 'all' | 'plans' (p_plans) | 'emails' (p_emails,
-- lower-case) | 'signed_up' (created in [p_from, p_to)).
create or replace function public.credit_grant_audience(
  p_kind text, p_plans text[], p_emails text[], p_from timestamptz, p_to timestamptz, p_after uuid default null, p_limit int default 500
) returns table (id uuid, email text, full_name text, plan text)
language sql stable security definer set search_path = public, auth as $$
  select u.id, u.email::text, p.full_name, coalesce(p.plan, 'free')
  from auth.users u
  join public.profiles p on p.id = u.id
  where (p_after is null or u.id > p_after)
    and case p_kind
      when 'all' then true
      when 'plans' then coalesce(p.plan, 'free') = any (p_plans)
      when 'emails' then lower(u.email::text) = any (p_emails)
      when 'signed_up' then u.created_at >= p_from and u.created_at < p_to
      else false
    end
  order by u.id
  limit least(greatest(p_limit, 1), 1000)
$$;

-- ── 0057/0059 functions, regenerated with the credit-aware balance (only the marked lines changed) ──

create or replace function public.quota_account_snapshot(acc public.quota_accounts)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'account_id', acc.id,
    'plan', acc.plan,
    'allowance', acc.allowance,
    'used', acc.used,
    'adjustments', acc.adjustments,
    'credits', acc.credits,
    'credit_drawn', acc.credit_drawn,
    'reserved', acc.reserved,
    'remaining', public.quota_remaining(acc),
    'period_start', acc.period_start,
    'period_end', acc.period_end,
    'status', acc.status
  )
$$;

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
      credit_drawn = 0,
      notified_threshold = 0,
      updated_at = p_now
    where id = p_account
    returning * into acc;
  end if;
  return public.quota_expire_credits(acc, p_now);
end $$;

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
    credit_drawn = 0,
    notified_threshold = 0,
    updated_at = p_now
  where id = p_account;
end $$;

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

  remaining := public.quota_remaining(acc);
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
  remaining := public.quota_remaining(acc);
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
    usage_source, call_status, conversation_id, request_id, attempt, streaming, latency_ms, meter_version, created_at,
    usage_multiplier, multiplier_id, base_billable_tokens
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
    p_now,
    (p_event ->> 'usage_multiplier')::numeric,
    nullif(p_event ->> 'multiplier_id', '')::uuid,
    (p_event ->> 'base_billable_tokens')::bigint
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;

  if v_id is null then
    return public.quota_account_snapshot(acc) || jsonb_build_object('ok', public.quota_remaining(acc) > 0, 'duplicate', true);
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
  -- Past the month's allowance: the overflow is paid from credit grants (soonest expiry first).
  acc := public.quota_draw_credits(acc, v_id, null, p_now);

  remaining := public.quota_remaining(acc);
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
  acc := public.quota_draw_credits(acc, null, v_id, p_now);
  return public.quota_account_snapshot(acc) || jsonb_build_object('applied', true);
end $$;

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
  ),
  g as (
    select a.id, coalesce(sum(cg.remaining), 0)::bigint as total
    from a left join public.quota_credit_grants cg on cg.account_id = a.id and cg.status = 'active'
    group by a.id
  ),
  d as (
    select a.id, coalesce(sum(cd.tokens), 0)::bigint as total
    from a left join public.quota_credit_draws cd on cd.account_id = a.id and cd.period_start = a.period_start
    group by a.id
  )
  select a.id, 'used', a.used, l.total from a join l on l.id = a.id where a.used <> l.total
  union all
  select a.id, 'adjustments', a.adjustments, j.total from a join j on j.id = a.id where a.adjustments <> j.total
  union all
  select a.id, 'reserved', a.reserved, h.total from a join h on h.id = a.id where a.reserved <> h.total
  union all
  select a.id, 'credits', a.credits, g.total from a join g on g.id = a.id where a.credits <> g.total
  union all
  select a.id, 'credit_drawn', a.credit_drawn, d.total from a join d on d.id = a.id where a.credit_drawn <> d.total
$$;

create or replace function public.quota_overspent(p_tolerance numeric)
returns table (account_id uuid, consumed bigint, allowance bigint)
language sql stable as $$
  select id, used + adjustments, allowance from public.quota_accounts
  where allowance > 0 and used + adjustments > (allowance + credit_drawn) * (1 + p_tolerance)
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'quota_remaining(public.quota_accounts)',
    'quota_expire_credits(public.quota_accounts, timestamptz)',
    'quota_draw_credits(public.quota_accounts, uuid, uuid, timestamptz)',
    'quota_grant_credits(uuid, uuid, bigint, timestamptz, text, text, uuid, text, boolean, uuid, text, timestamptz)',
    'quota_approve_credit_grant(uuid, uuid, timestamptz)',
    'quota_revoke_credit_grant(uuid, uuid, text, timestamptz)',
    'credit_grant_audience(text, text[], text[], timestamptz, timestamptz, uuid, int)',
    'quota_lock_account_by_id(uuid, timestamptz)',
    'quota_restart_period(uuid, timestamptz, timestamptz)',
    'quota_account_snapshot(public.quota_accounts)',
    'quota_reserve(uuid, uuid, uuid, bigint, jsonb, text, uuid, timestamptz)',
    'quota_extend_hold(uuid, bigint, timestamptz)',
    'quota_record_usage(uuid, jsonb, timestamptz)',
    'quota_adjust(uuid, bigint, text, text, uuid, text, timestamptz)',
    'quota_audit()',
    'quota_overspent(numeric)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%s from authenticated', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', fn); end if;
  end loop;
end $$;
