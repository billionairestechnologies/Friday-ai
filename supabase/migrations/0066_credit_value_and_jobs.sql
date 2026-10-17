-- 0066 Credit money value + a durable job queue (docs/product/V3_PROGRAM.md, phase 12).
--
-- Credit value: what 1M bonus tokens are worth in ₹ when an offer or grant is described in money
-- ("₹500 of credits"). Null until the owner sets it — nothing is ever converted with a made-up rate.
--
-- Jobs: background work that must survive restarts and be retried safely (bulk credit grants,
-- emails, …). A worker CLAIMS jobs atomically (FOR UPDATE SKIP LOCKED) under a lease; each tenant
-- (a person / organisation) gets at most one running job at a time, oldest first, so one customer's
-- 5,000-person bulk grant can't starve everyone else. Failures retry with exponential backoff and
-- jitter; after max_attempts a job is 'dead' (dead-letter) and shown in Console → Status → Jobs.
-- A worker that dies leaves an expired lease, which job_recover() requeues. Completing / failing
-- is fenced on the worker id, so a worker that lost its lease can't overwrite the new owner's result.

alter table public.credit_settings add column if not exists inr_per_million_tokens numeric(12, 2) check (inr_per_million_tokens is null or inr_per_million_tokens > 0);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'dead', 'cancelled')),
  tenant text,
  attempts int not null default 0,
  max_attempts int not null default 5 check (max_attempts between 1 and 20),
  run_after timestamptz not null default now(),
  lease_until timestamptz,
  worker text,
  idempotency_key text unique,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
-- No policies: backend only
alter table public.jobs enable row level security;
create index if not exists jobs_due_idx on public.jobs (run_after) where status = 'queued';
create index if not exists jobs_running_idx on public.jobs (tenant) where status = 'running';
create index if not exists jobs_status_idx on public.jobs (status, updated_at desc);

create or replace function public.job_claim(p_worker text, p_limit int, p_lease_seconds int, p_now timestamptz default now())
returns setof public.jobs language plpgsql as $$
begin
  return query
  with fair as (
    -- One candidate per tenant (its oldest due job); a tenant with a live running job waits its turn.
    select distinct on (coalesce(j.tenant, j.id::text)) j.id, j.run_after, j.created_at
    from public.jobs j
    where j.status = 'queued' and j.run_after <= p_now
      and (j.tenant is null or not exists (
        select 1 from public.jobs r where r.status = 'running' and r.tenant = j.tenant and r.lease_until > p_now))
    order by coalesce(j.tenant, j.id::text), j.run_after, j.created_at
  ),
  picked as (
    select j.id from public.jobs j
    where j.id in (select id from fair) and j.status = 'queued'
    order by j.run_after, j.created_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update public.jobs j set
    status = 'running', attempts = j.attempts + 1, worker = p_worker,
    lease_until = p_now + make_interval(secs => p_lease_seconds), started_at = p_now, updated_at = p_now
  from picked where j.id = picked.id
  returning j.*;
end $$;

create or replace function public.job_heartbeat(p_job uuid, p_worker text, p_lease_seconds int, p_now timestamptz default now())
returns boolean language sql as $$
  update public.jobs set lease_until = p_now + make_interval(secs => p_lease_seconds), updated_at = p_now
  where id = p_job and worker = p_worker and status = 'running'
  returning true
$$;

create or replace function public.job_complete(p_job uuid, p_worker text, p_result jsonb, p_now timestamptz default now())
returns boolean language sql as $$
  update public.jobs set status = 'succeeded', result = p_result, finished_at = p_now, lease_until = null, last_error = null, updated_at = p_now
  where id = p_job and worker = p_worker and status = 'running'
  returning true
$$;

-- Retry with backoff (10 s · 2^(attempt−1), capped at 1 h, ±20 % jitter) or dead-letter.
create or replace function public.job_fail(p_job uuid, p_worker text, p_error text, p_retryable boolean, p_now timestamptz default now())
returns text language plpgsql as $$
declare
  j public.jobs;
  delay double precision;
begin
  select * into j from public.jobs where id = p_job for update;
  if not found or j.worker is distinct from p_worker or j.status <> 'running' then return 'lost'; end if;
  if not p_retryable or j.attempts >= j.max_attempts then
    update public.jobs set status = 'dead', last_error = left(p_error, 2000), finished_at = p_now, lease_until = null, updated_at = p_now where id = p_job;
    return 'dead';
  end if;
  delay := least(3600, 10 * power(2, j.attempts - 1)) * (0.8 + random() * 0.4);
  update public.jobs set status = 'queued', last_error = left(p_error, 2000), lease_until = null, worker = null,
    run_after = p_now + make_interval(secs => delay), updated_at = p_now where id = p_job;
  return 'retry';
end $$;

-- Jobs whose worker vanished (lease expired): back to the queue, or dead if out of attempts.
create or replace function public.job_recover(p_now timestamptz default now())
returns int language plpgsql as $$
declare
  n int;
begin
  with stale as (
    update public.jobs set
      status = case when attempts >= max_attempts then 'dead' else 'queued' end,
      last_error = coalesce(last_error, '') || case when last_error is null then '' else ' · ' end || 'worker stopped (lease expired)',
      finished_at = case when attempts >= max_attempts then p_now else finished_at end,
      worker = null, lease_until = null, run_after = p_now, updated_at = p_now
    where status = 'running' and lease_until < p_now
    returning 1
  )
  select count(*) into n from stale;
  return n;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'job_claim(text, int, int, timestamptz)', 'job_heartbeat(uuid, text, int, timestamptz)', 'job_complete(uuid, text, jsonb, timestamptz)',
    'job_fail(uuid, text, text, boolean, timestamptz)', 'job_recover(timestamptz)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%s from authenticated', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', fn); end if;
  end loop;
end $$;
