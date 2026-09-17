-- Attachment object-storage fields. Inline data_url remains for small/legacy blobs and
-- local/dev fallbacks when Supabase Storage is unavailable.
alter table public.message_attachments
  add column if not exists storage_bucket text,
  add column if not exists storage_path text;

alter table public.message_attachments
  alter column data_url drop not null;

alter table public.message_attachments
  add constraint message_attachments_payload_present
  check (data_url is not null or (storage_bucket is not null and storage_path is not null));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'message-attachments',
  'message-attachments',
  false,
  31457280,
  array[
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain'
  ]
)
on conflict (id) do nothing;

drop policy if exists "message_attachments_storage: owner read" on storage.objects;
create policy "message_attachments_storage: owner read"
  on storage.objects for select
  using (
    bucket_id = 'message-attachments'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- External OAuth connectors (GitHub first).
create table if not exists public.connector_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null check (provider in ('github')),
  external_account_id text not null,
  account_login text,
  account_name text,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  scopes text[] not null default '{}'::text[],
  metadata jsonb not null default '{}'::jsonb,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

alter table public.connector_accounts enable row level security;

drop policy if exists "connector_accounts: owner full access" on public.connector_accounts;
create policy "connector_accounts: owner full access" on public.connector_accounts
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index if not exists connector_accounts_user_id_idx
  on public.connector_accounts (user_id);

-- Organization invites for team admin flows.
create table if not exists public.organization_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  invited_by uuid references public.profiles (id) on delete set null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.organization_invites enable row level security;

drop policy if exists "organization_invites: org admins manage" on public.organization_invites;
create policy "organization_invites: org admins manage" on public.organization_invites
  for all using (
    exists (
      select 1
      from public.organization_memberships m
      where m.organization_id = organization_invites.organization_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1
      from public.organization_memberships m
      where m.organization_id = organization_invites.organization_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

create index if not exists organization_invites_org_idx
  on public.organization_invites (organization_id, created_at desc);
create index if not exists organization_invites_email_idx
  on public.organization_invites (lower(email));
