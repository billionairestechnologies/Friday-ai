-- ─────────────────────────────────────────────────────────────────────────
-- Privacy Policy / Terms of Service acceptance. `policy_version` is the dated
-- version string the account last agreed to (see POLICY_VERSION in
-- backend/src/services/policyService.ts); null means never agreed — true for
-- every account created before this shipped, so the web/Android/iOS clients
-- show a blocking "I agree" gate on next open until they accept. New signups
-- set this immediately (the signup form has its own required checkbox).
--
-- A row-per-acceptance history table (rather than just overwriting the two
-- columns above) so there is a durable, appendable audit trail of what a
-- user agreed to and when — the two profile columns stay as a fast "what's
-- the current status" read; this table is the record of every accept event
-- (including re-accepting after a policy update).
-- ─────────────────────────────────────────────────────────────────────────
alter table public.profiles add column policy_version text;
alter table public.profiles add column policy_accepted_at timestamptz;

create table if not exists public.policy_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  policy_version text not null,
  platform text not null check (platform in ('web', 'android', 'ios')),
  accepted_at timestamptz not null default now()
);
create index if not exists policy_acceptances_user_idx on public.policy_acceptances (user_id, accepted_at desc);
alter table public.policy_acceptances enable row level security;
-- No policies: only the backend (service role) reads/writes this table.
