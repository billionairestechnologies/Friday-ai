-- Company mail: our own hosted mailboxes (name@yourcompany.com on the company mail server) that the
-- admin creates for employees, and a webmail inside the Team Console that can also open any other
-- IMAP account (Gmail, Outlook, Zoho…). Hosted mailboxes are real IMAP/SMTP accounts, so employees
-- can ALSO sign in from Gmail's app, Outlook, Apple Mail or a phone with the same address/password.

-- Domains the mail server hosts.
create table if not exists public.mail_domains (
  id uuid primary key default gen_random_uuid(),
  domain text not null unique check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  description text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- No policies: backend only
alter table public.mail_domains enable row level security;

-- One hosted mailbox per address. The password lives on the mail server; we keep an encrypted copy
-- only so the owner's webmail can sign in for them (utils/crypto.ts).
create table if not exists public.mailboxes (
  id uuid primary key default gen_random_uuid(),
  address text not null unique,
  domain_id uuid not null references public.mail_domains(id) on delete cascade,
  local_part text not null,
  display_name text not null default '',
  owner_user_id uuid references auth.users(id) on delete set null,
  quota_mb integer not null default 5120 check (quota_mb between 100 and 102400),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mailboxes_owner_idx on public.mailboxes (owner_user_id);

-- No policies: backend only
alter table public.mailboxes enable row level security;

-- Accounts a staff member reads in the Console webmail: their hosted mailbox and any external
-- IMAP/SMTP account they add (Gmail with an app password, Outlook, Zoho…).
create table if not exists public.mail_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('hosted', 'external')),
  mailbox_id uuid references public.mailboxes(id) on delete cascade,
  label text not null default '',
  email text not null,
  display_name text not null default '',
  imap_host text not null,
  imap_port integer not null default 993,
  imap_secure boolean not null default true,
  smtp_host text not null,
  smtp_port integer not null default 465,
  smtp_secure boolean not null default true,
  username text not null,
  secret_encrypted text not null,
  is_default boolean not null default false,
  last_error text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, email)
);

create index if not exists mail_accounts_user_idx on public.mail_accounts (user_id);

-- No policies: backend only
alter table public.mail_accounts enable row level security;
