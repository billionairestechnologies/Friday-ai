create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  plan text not null default 'free' check (plan in ('free', 'pro', 'business', 'enterprise')),
  monthly_budget_cents int not null default 0,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_memberships (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  event_type text not null check (event_type in ('chat_message', 'web_search', 'voice_second', 'sandbox_run', 'attachment_upload')),
  quantity numeric not null default 1,
  estimated_cost_cents numeric not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles (id) on delete set null,
  organization_id uuid references public.organizations (id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.usage_events enable row level security;
alter table public.admin_audit_logs enable row level security;

create policy "organizations: members read" on public.organizations
  for select using (
    exists (
      select 1 from public.organization_memberships m
      where m.organization_id = id and m.user_id = auth.uid()
    )
  );

create policy "organization_memberships: members read own orgs" on public.organization_memberships
  for select using (
    user_id = auth.uid()
    or exists (
      select 1 from public.organization_memberships m
      where m.organization_id = public.organization_memberships.organization_id and m.user_id = auth.uid()
    )
  );

create policy "usage_events: user read own usage" on public.usage_events
  for select using (user_id = auth.uid());

create policy "admin_audit_logs: admin read" on public.admin_audit_logs
  for select using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create index if not exists organization_memberships_user_id_idx
  on public.organization_memberships (user_id);
create index if not exists usage_events_user_created_idx
  on public.usage_events (user_id, created_at desc);
create index if not exists usage_events_org_created_idx
  on public.usage_events (organization_id, created_at desc);
create index if not exists admin_audit_logs_created_idx
  on public.admin_audit_logs (created_at desc);
