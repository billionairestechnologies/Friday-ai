-- 0059 Model usage multipliers (docs/product/V3_PROGRAM.md, phase 03a).
--
-- Each model can cost more or less of a plan's monthly allowance: billable = ⌈base billable × multiplier⌉,
-- where base billable is the existing rule (quota/allowance.ts). Multipliers are APPEND-ONLY versions:
-- a change is a new row, never an edit, so the history is the table and a revert is just a new row
-- with the old value. Each token_ledger row stores the multiplier it was charged at (and the row id),
-- so a change never rewrites past usage — it applies to calls recorded after it takes effect.
--
--   kind 'base'  : the model's standing multiplier from effective_from on (until a later base row).
--   kind 'promo' : a temporary override for [effective_from, effective_to); beats any base row.
--   provider_slug '*' : applies to that model id on every provider; an exact provider row wins.
--
-- Precedence (resolveMultiplier in services/quota/multipliers.ts): exact promo > wildcard promo >
-- exact base > wildcard base > 1×. A cancelled row never applies (cancelling = scheduled change
-- withdrawn, or a running promo ended early).
--
-- A 0× multiplier makes calls free for the customer only: cost_usd is still recorded on every row.

create table if not exists public.model_multipliers (
  id uuid primary key default gen_random_uuid(),
  provider_slug text not null,
  model_id text not null,
  multiplier numeric(10, 4) not null check (multiplier >= 0 and multiplier <= 100),
  kind text not null check (kind in ('base', 'promo')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  reason text not null check (length(reason) between 3 and 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users (id) on delete set null,
  check (effective_to is null or effective_to > effective_from),
  check (kind = 'base' or effective_to is not null)
);
-- No policies: backend only
alter table public.model_multipliers enable row level security;
create index if not exists model_multipliers_model_idx on public.model_multipliers (model_id, provider_slug, created_at desc);

alter table public.token_ledger
  add column if not exists usage_multiplier numeric(10, 4),
  add column if not exists multiplier_id uuid,
  add column if not exists base_billable_tokens bigint;

-- Publishes one or more multiplier rows atomically. Optimistic concurrency: each row carries
-- `expected_latest`, the id of the newest row for that model the admin was looking at (null = none);
-- if anyone published for that model since, the whole batch is refused ('stale_multiplier') so a
-- stale screen can never silently overwrite a teammate's change.
create or replace function public.model_multiplier_publish(p_rows jsonb, p_actor uuid, p_now timestamptz default now())
returns setof public.model_multipliers language plpgsql as $$
declare
  item jsonb;
  v_latest uuid;
  v_from timestamptz;
  v_row public.model_multipliers;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'no rows to publish'; end if;
  -- Lock every model in a stable order first (bulk publishes can't deadlock each other).
  for item in select value from jsonb_array_elements(p_rows) order by value ->> 'provider_slug', value ->> 'model_id' loop
    perform pg_advisory_xact_lock(hashtext('model_multiplier:' || (item ->> 'provider_slug') || '/' || (item ->> 'model_id')));
  end loop;
  for item in select value from jsonb_array_elements(p_rows) loop
    select id into v_latest from public.model_multipliers
      where provider_slug = item ->> 'provider_slug' and model_id = item ->> 'model_id'
      order by created_at desc, id desc limit 1;
    if v_latest is distinct from nullif(item ->> 'expected_latest', '')::uuid then
      raise exception 'stale_multiplier: % / %', item ->> 'provider_slug', item ->> 'model_id';
    end if;
    -- Never backdated: a change applies from now (or a future time) onward.
    v_from := greatest(coalesce(nullif(item ->> 'effective_from', '')::timestamptz, p_now), p_now);
    insert into public.model_multipliers (provider_slug, model_id, multiplier, kind, effective_from, effective_to, reason, created_by, created_at)
      values (
        item ->> 'provider_slug', item ->> 'model_id', (item ->> 'multiplier')::numeric, item ->> 'kind',
        v_from, nullif(item ->> 'effective_to', '')::timestamptz, item ->> 'reason', p_actor, p_now
      )
      returning * into v_row;
    return next v_row;
  end loop;
end $$;

-- Withdraws a scheduled row or ends a running promo now. A base row already in effect can't be
-- cancelled (that would silently change what "current" means) — publish a new value instead.
create or replace function public.model_multiplier_cancel(p_id uuid, p_actor uuid, p_now timestamptz default now())
returns public.model_multipliers language plpgsql as $$
declare
  v_row public.model_multipliers;
begin
  select * into v_row from public.model_multipliers where id = p_id for update;
  if not found then raise exception 'multiplier % not found', p_id; end if;
  if v_row.cancelled_at is not null then return v_row; end if;
  if v_row.kind = 'base' and v_row.effective_from <= p_now then
    raise exception 'active_base_multiplier: publish a new value instead of cancelling';
  end if;
  if v_row.kind = 'promo' and v_row.effective_to <= p_now then
    raise exception 'promo_already_ended';
  end if;
  update public.model_multipliers set cancelled_at = p_now, cancelled_by = p_actor where id = p_id returning * into v_row;
  return v_row;
end $$;

-- Usage per model since a date, for the change preview: what the model's calls cost before any
-- multiplier (base) and what they were charged. Rows from before 0059 have no base figure; it is
-- recomputed from their raw columns with the same rule as billableTokens() (billable 0 = not charged).
create or replace function public.model_multiplier_usage(p_since timestamptz)
returns table (provider_slug text, model_id text, calls bigint, users bigint, base_billable bigint, billable bigint, cost_usd numeric)
language sql stable as $$
  select l.provider_slug, l.model_id, count(*), count(distinct l.user_id),
    coalesce(sum(coalesce(l.base_billable_tokens,
      case when l.billable_tokens = 0 then 0
        else greatest(0, l.input_tokens - l.cached_tokens) + l.output_tokens + ceil(l.cached_tokens * 0.1)::bigint end)), 0)::bigint,
    coalesce(sum(l.billable_tokens), 0)::bigint,
    coalesce(sum(l.cost_usd), 0)
  from public.token_ledger l
  where l.created_at >= p_since and l.account_id is not null
  group by l.provider_slug, l.model_id
$$;

-- quota_record_usage, unchanged from 0057 except that it now stores the applied multiplier.
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

do $$
declare fn text;
begin
  foreach fn in array array[
    'model_multiplier_publish(jsonb, uuid, timestamptz)',
    'model_multiplier_cancel(uuid, uuid, timestamptz)',
    'model_multiplier_usage(timestamptz)',
    'quota_record_usage(uuid, jsonb, timestamptz)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%s from authenticated', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', fn); end if;
  end loop;
end $$;
