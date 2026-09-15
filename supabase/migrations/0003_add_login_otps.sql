-- ─────────────────────────────────────────────────────────────────────────
-- Login now requires an email OTP after password verification. The Supabase
-- session obtained from the password check is held here (not returned to the
-- client) until the OTP is confirmed, so no second password prompt is needed.
-- ─────────────────────────────────────────────────────────────────────────
create table public.login_otps (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code text not null,
  session jsonb not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);

create index login_otps_email_idx on public.login_otps (email);

-- Only the backend (service role) ever touches this table.
alter table public.login_otps enable row level security;
