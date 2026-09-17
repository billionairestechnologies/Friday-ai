-- Pending login challenges contain authentication material and must not be
-- readable as plaintext if a database backup or service-role query leaks.
-- Existing challenges are short-lived, so invalidate them during migration.
delete from public.login_otps;

alter table public.login_otps
  add column code_hash text,
  add column session_ciphertext text;

alter table public.login_otps
  alter column code_hash set not null,
  alter column session_ciphertext set not null;

alter table public.login_otps
  drop column code,
  drop column session;

drop index if exists public.login_otps_email_idx;
create unique index login_otps_email_idx on public.login_otps (email);
create index login_otps_expiry_idx on public.login_otps (expires_at);
