-- Friday X (terminal + IDE coding agent): device-code login and long-lived, revocable CLI tokens.
--
-- The CLI never sees a Supabase session. `friday login` starts a device authorisation, the user approves
-- it in the signed-in web app, and the CLI is handed an opaque token (`fxt_…`). Only its SHA-256 is stored,
-- so a database leak can't be replayed. A token is scoped to /api/x/* and is revoked from Settings.
-- No policies: backend only.

create table if not exists public.cli_device_codes (
  id uuid primary key default gen_random_uuid(),
  -- SHA-256 of the secret device_code the CLI polls with.
  device_code_hash text not null unique,
  -- Short human code the user confirms in the browser (ABCD-EFGH).
  user_code text not null unique,
  client_name text,
  client_version text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'used')),
  user_id uuid references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  last_polled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists cli_device_codes_expires_idx on public.cli_device_codes (expires_at);
alter table public.cli_device_codes enable row level security;

create table if not exists public.cli_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  -- "Friday X CLI on MacBook-Pro", "Friday X for VS Code" … shown in Settings so a user can revoke one.
  name text not null default 'Friday X',
  client text not null default 'cli',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists cli_tokens_user_idx on public.cli_tokens (user_id) where revoked_at is null;
alter table public.cli_tokens enable row level security;

-- The usage breakdown groups by feature; Friday X spend shows as "code".
-- (token_ledger.feature is free text, no constraint to change.)
