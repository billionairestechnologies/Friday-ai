-- 0061 Offers v2 + student / startup / company programmes (docs/product/V3_PROGRAM.md, phase 04).
--
-- Offers:
--   * kind 'credits': redeeming grants bonus credits (supabase 0060) — credit_tokens, expiring
--     credit_days after redemption.
--   * state: draft | active | paused | archived (scheduled / expired are derived from the dates).
--     `active` (0032) is kept in sync for older readers: active = (state = 'active').
--   * exclusive_group: a person can hold at most ONE applied redemption per group (no stacking).
--   * headline / terms: the public copy shown when redeeming.
--   * eligibility 'existing_users' (accounts older than the new-user window).
--
-- Redemption is now claimed atomically in SQL (offer_claim): the offer row is locked, state /
-- dates / cap / per-person / group are checked, and the slot is taken in one transaction. The app
-- then applies the benefit and confirms (offer_confirm) — or gives the slot back (offer_release) if
-- applying failed. Before, two quick taps could both pass the "already used?" check and apply twice,
-- and a failed apply still used up a slot.
--
-- Programmes: program_settings (one row per programme: what approval grants) + program_applications
-- (the form, evidence files in a private bucket, review trail, validity / re-verification date).

alter table public.offers drop constraint if exists offers_kind_check;
alter table public.offers add constraint offers_kind_check check (kind in ('plan_grant', 'package', 'discount', 'credits'));
alter table public.offers drop constraint if exists offers_eligibility_check;
alter table public.offers add constraint offers_eligibility_check check (eligibility in ('anyone', 'new_users', 'existing_users', 'email_domain', 'student'));
alter table public.offers
  add column if not exists credit_tokens bigint check (credit_tokens is null or credit_tokens > 0),
  add column if not exists credit_days int check (credit_days is null or credit_days > 0),
  add column if not exists state text,
  add column if not exists exclusive_group text,
  add column if not exists headline text not null default '',
  add column if not exists terms text not null default '';
update public.offers set state = case when active then 'active' else 'paused' end where state is null;
alter table public.offers alter column state set default 'active';
alter table public.offers alter column state set not null;
do $$ begin
  alter table public.offers add constraint offers_state_check check (state in ('draft', 'active', 'paused', 'archived'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.offers add constraint offers_credits_check check (kind <> 'credits' or credit_tokens is not null);
exception when duplicate_object then null; end $$;

alter table public.offer_redemptions drop constraint if exists offer_redemptions_status_check;
alter table public.offer_redemptions add constraint offer_redemptions_status_check check (status in ('pending', 'claimed', 'applied', 'rejected', 'failed'));
alter table public.offer_redemptions
  add column if not exists exclusive_group text,
  add column if not exists applied_at timestamptz,
  add column if not exists benefit jsonb not null default '{}'::jsonb;
create index if not exists offer_redemptions_group_idx on public.offer_redemptions (user_id, exclusive_group) where exclusive_group is not null;

-- Claims a redemption for p_user. p_review = the benefit needs a teammate's approval first (no slot
-- taken yet). Returns {redemption_id, status, duplicate}. Errors (raised, so nothing is written):
-- offer_not_found, offer_not_active, offer_not_started, offer_expired, offer_full, offer_group_conflict,
-- offer_rejected.
create or replace function public.offer_claim(p_offer uuid, p_user uuid, p_review boolean, p_proof text, p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  o public.offers;
  r public.offer_redemptions;
begin
  select * into o from public.offers where id = p_offer for update;
  if not found then raise exception 'offer_not_found'; end if;
  select * into r from public.offer_redemptions where offer_id = p_offer and user_id = p_user for update;
  if found and r.status in ('pending', 'claimed', 'applied') then
    return jsonb_build_object('redemption_id', r.id, 'status', r.status, 'duplicate', true);
  end if;
  if found and r.status = 'rejected' then raise exception 'offer_rejected'; end if;
  if o.state <> 'active' then raise exception 'offer_not_active'; end if;
  if o.starts_at is not null and o.starts_at > p_now then raise exception 'offer_not_started'; end if;
  if o.expires_at is not null and o.expires_at <= p_now then raise exception 'offer_expired'; end if;
  if not p_review and o.max_redemptions is not null and o.redemption_count >= o.max_redemptions then raise exception 'offer_full'; end if;
  if o.exclusive_group is not null and exists (
    select 1 from public.offer_redemptions x
    where x.user_id = p_user and x.exclusive_group = o.exclusive_group and x.offer_id <> p_offer and x.status in ('pending', 'claimed', 'applied')
  ) then
    raise exception 'offer_group_conflict';
  end if;
  if found then
    -- A failed earlier attempt: try again on the same row.
    update public.offer_redemptions set status = case when p_review then 'pending' else 'claimed' end, proof = coalesce(p_proof, ''),
      exclusive_group = o.exclusive_group, created_at = p_now
      where id = r.id returning * into r;
  else
    insert into public.offer_redemptions (offer_id, user_id, status, proof, exclusive_group, created_at)
      values (p_offer, p_user, case when p_review then 'pending' else 'claimed' end, coalesce(p_proof, ''), o.exclusive_group, p_now)
      returning * into r;
  end if;
  if not p_review then
    update public.offers set redemption_count = redemption_count + 1 where id = p_offer;
  end if;
  return jsonb_build_object('redemption_id', r.id, 'status', r.status, 'duplicate', false);
end $$;

-- A reviewer approves a pending redemption: takes the slot now (the cap applies at approval).
create or replace function public.offer_approve_claim(p_redemption uuid, p_actor uuid, p_note text, p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  r public.offer_redemptions;
  o public.offers;
begin
  select * into r from public.offer_redemptions where id = p_redemption for update;
  if not found then raise exception 'redemption_not_found'; end if;
  if r.status in ('claimed', 'applied') then return jsonb_build_object('redemption_id', r.id, 'status', r.status, 'duplicate', true); end if;
  if r.status <> 'pending' then raise exception 'redemption_not_pending'; end if;
  select * into o from public.offers where id = r.offer_id for update;
  if o.max_redemptions is not null and o.redemption_count >= o.max_redemptions then raise exception 'offer_full'; end if;
  update public.offers set redemption_count = redemption_count + 1 where id = o.id;
  update public.offer_redemptions set status = 'claimed', note = coalesce(p_note, ''), reviewed_by = p_actor, reviewed_at = p_now where id = r.id;
  return jsonb_build_object('redemption_id', r.id, 'status', 'claimed', 'duplicate', false);
end $$;

-- The benefit was applied: claimed → applied (idempotent).
create or replace function public.offer_confirm(p_redemption uuid, p_benefit jsonb, p_now timestamptz default now())
returns void language plpgsql as $$
begin
  update public.offer_redemptions set status = 'applied', applied_at = p_now, benefit = coalesce(p_benefit, '{}'::jsonb)
    where id = p_redemption and status = 'claimed';
end $$;

-- Applying the benefit failed: give the slot back so a retry (or someone else) can use it.
create or replace function public.offer_release(p_redemption uuid, p_reason text)
returns void language plpgsql as $$
declare
  r public.offer_redemptions;
begin
  select * into r from public.offer_redemptions where id = p_redemption for update;
  if not found or r.status <> 'claimed' then return; end if;
  update public.offer_redemptions set status = 'failed', note = left(coalesce(p_reason, ''), 500) where id = r.id;
  update public.offers set redemption_count = greatest(0, redemption_count - 1) where id = r.offer_id;
end $$;

-- ── Programmes ───────────────────────────────────────────────────────────────

create table if not exists public.program_settings (
  id text primary key check (id in ('student', 'startup', 'company')),
  enabled boolean not null default false,
  title text not null,
  description text not null default '',
  -- What an approval grants: an existing offer kind's benefit, configured here.
  benefit_kind text not null default 'credits' check (benefit_kind in ('plan_grant', 'package', 'credits')),
  plan text check (plan in ('pro', 'premium')),
  package_id uuid references public.plan_packages (id) on delete set null,
  duration_days int check (duration_days is null or duration_days > 0),
  credit_tokens bigint check (credit_tokens is null or credit_tokens > 0),
  credit_days int check (credit_days is null or credit_days > 0),
  -- Approval is valid this long; then the person re-verifies (renewal).
  valid_days int not null default 365 check (valid_days > 0),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
-- No policies: backend only
alter table public.program_settings enable row level security;
insert into public.program_settings (id, title, description, benefit_kind, plan, duration_days, valid_days) values
  ('student', 'Student programme', 'For students at a recognised college or university.', 'plan_grant', 'pro', 180, 365)
  on conflict (id) do nothing;
insert into public.program_settings (id, title, description, benefit_kind, credit_tokens, credit_days, valid_days) values
  ('startup', 'Startup programme', 'For early-stage startups building with AI.', 'credits', 50000000, 180, 365)
  on conflict (id) do nothing;
insert into public.program_settings (id, title, description, benefit_kind, valid_days) values
  ('company', 'Company & enterprise', 'Custom pricing, seats and access for teams. Our team will follow up.', 'package', 365)
  on conflict (id) do nothing;

create table if not exists public.program_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  program text not null references public.program_settings (id),
  status text not null default 'submitted' check (status in ('submitted', 'needs_info', 'approved', 'rejected', 'withdrawn', 'expired')),
  -- The form (institution, course, graduation / company, website, team size, needs …) — validated per programme in the app.
  details jsonb not null default '{}'::jsonb,
  -- [{id, name, mime, size, path}] in the private 'program-evidence' bucket. Paths never leave the backend.
  evidence jsonb not null default '[]'::jsonb,
  info_request text,
  reviewer_id uuid,
  decision_note text,
  -- Overrides the programme's default benefit for this one approval (company deals).
  benefit_override jsonb,
  benefit jsonb not null default '{}'::jsonb,
  valid_until timestamptz,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- No policies: backend only
alter table public.program_applications enable row level security;
create index if not exists program_applications_queue_idx on public.program_applications (status, created_at);
-- One open application per person per programme.
create unique index if not exists program_applications_open_idx on public.program_applications (user_id, program) where status in ('submitted', 'needs_info');

-- Decides an application exactly once (approve / reject / ask for info). Returns the row; raises
-- application_not_open if it was already decided (a second reviewer, a double click).
create or replace function public.program_decide(p_application uuid, p_status text, p_actor uuid, p_note text, p_valid_until timestamptz, p_now timestamptz default now())
returns public.program_applications language plpgsql as $$
declare
  a public.program_applications;
begin
  if p_status not in ('approved', 'rejected', 'needs_info') then raise exception 'bad_status'; end if;
  select * into a from public.program_applications where id = p_application for update;
  if not found then raise exception 'application_not_found'; end if;
  if a.status not in ('submitted', 'needs_info') then raise exception 'application_not_open'; end if;
  update public.program_applications set
    status = p_status,
    reviewer_id = p_actor,
    decision_note = case when p_status = 'needs_info' then a.decision_note else p_note end,
    info_request = case when p_status = 'needs_info' then p_note else a.info_request end,
    valid_until = case when p_status = 'approved' then p_valid_until else a.valid_until end,
    decided_at = case when p_status = 'needs_info' then a.decided_at else p_now end,
    updated_at = p_now
  where id = a.id returning * into a;
  return a;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'offer_claim(uuid, uuid, boolean, text, timestamptz)',
    'offer_approve_claim(uuid, uuid, text, timestamptz)',
    'offer_confirm(uuid, jsonb, timestamptz)',
    'offer_release(uuid, text)',
    'program_decide(uuid, text, uuid, text, timestamptz, timestamptz)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%s from authenticated', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', fn); end if;
  end loop;
end $$;

-- Private bucket for application evidence (student ID, incorporation certificate…). Backend-only:
-- reviewers get short-lived signed links; no public URL exists.
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('program-evidence', 'program-evidence', false, 5242880, array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
      on conflict (id) do nothing;
  end if;
end $$;
