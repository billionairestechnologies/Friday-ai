-- ─────────────────────────────────────────────────────────────────────────
-- Team Console: the internal back office behind /admin — staff accounts with
-- roles and permissions, product updates shown once to every user (and every
-- new user) as an in-app popup, marketing email campaigns, a CRM for leads and
-- clients, a support center, shared tasks, and team mail identities.
--
-- Everything here is backend-only: RLS on, no policies — the API (service
-- role) is the only reader/writer and enforces staff permissions itself.
-- Roles and CRM stages are data (seeded below, editable from the console), not
-- hardcoded in the app.
-- ─────────────────────────────────────────────────────────────────────────

-- Staff roles: a named bundle of permission strings ("support.reply", "crm.*", "*").
create table if not exists public.staff_roles (
  id text primary key,
  name text not null,
  description text not null default '',
  permissions text[] not null default '{}',
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.staff_roles enable row level security;
-- No policies: backend only.

insert into public.staff_roles (id, name, description, permissions, is_system) values
  ('owner', 'Owner', 'Full access to everything, including team and roles.', '{*}', true),
  ('admin', 'Admin', 'Full access to everything, including team and roles.', '{*}', true),
  ('support', 'Support', 'Works the support inbox and helps users.', '{overview.view,support.view,support.reply,support.manage,users.view,tasks.view,tasks.manage,crm.view}', true),
  ('marketing', 'Marketing', 'Ships product updates and email campaigns.', '{overview.view,updates.view,updates.manage,marketing.view,marketing.manage,marketing.send,users.view,tasks.view,tasks.manage,crm.view}', true),
  ('sales', 'Sales', 'Owns leads, clients and the pipeline.', '{overview.view,crm.view,crm.manage,users.view,tasks.view,tasks.manage,support.view}', true),
  ('operations', 'Operations', 'Runs plans, quotas, models and day-to-day operations.', '{overview.view,users.view,users.manage,providers.view,providers.manage,support.view,tasks.view,tasks.manage,audit.view}', true),
  ('developer', 'Developer', 'Model providers, releases and technical support.', '{overview.view,providers.view,providers.manage,updates.view,updates.manage,support.view,tasks.view,tasks.manage,audit.view}', true)
on conflict (id) do nothing;

-- Staff members: a Friday account that can sign in to the console with a role.
-- (profiles.role = 'admin' accounts are always treated as owners.)
create table if not exists public.staff_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role_id text not null references public.staff_roles (id),
  title text not null default '',
  team text not null default '',
  active boolean not null default true,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.staff_members enable row level security;
-- No policies: backend only.

-- Team mail identities: the addresses the team sends from (support@, hello@, sales@…).
create table if not exists public.mail_identities (
  id uuid primary key default gen_random_uuid(),
  address text not null unique,
  display_name text not null default 'Friday',
  team text not null default '',
  purpose text not null default 'general' check (purpose in ('general', 'support', 'marketing', 'sales')),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.mail_identities enable row level security;
-- No policies: backend only.

-- ── Product updates ─────────────────────────────────────────────────────────
-- Shown ONCE to each matching user as an in-app "What's new" popup — including
-- users who sign up later, while the update is live.
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  image_url text,
  cta_label text,
  cta_url text,
  kind text not null default 'feature' check (kind in ('feature', 'improvement', 'news', 'maintenance')),
  audience text not null default 'all' check (audience in ('all', 'free', 'paid', 'pro', 'premium', 'new_users')),
  platforms text[] not null default '{web,android,ios}',
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  publish_at timestamptz,
  expires_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.announcements enable row level security;
-- No policies: backend only.
create index if not exists announcements_live_idx on public.announcements (status, publish_at);

create table if not exists public.announcement_views (
  announcement_id uuid not null references public.announcements (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  seen_at timestamptz not null default now(),
  clicked boolean not null default false,
  primary key (announcement_id, user_id)
);
alter table public.announcement_views enable row level security;
-- No policies: backend only.

-- ── Marketing email ────────────────────────────────────────────────────────
alter table public.profiles add column if not exists marketing_opt_out boolean not null default false;

create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  preheader text not null default '',
  body_markdown text not null default '',
  cta_label text,
  cta_url text,
  audience text not null default 'all' check (audience in ('all', 'free', 'paid', 'pro', 'premium', 'new_users')),
  from_identity_id uuid references public.mail_identities (id) on delete set null,
  announcement_id uuid references public.announcements (id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  total_recipients int not null default 0,
  sent_count int not null default 0,
  failed_count int not null default 0,
  last_error text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.email_campaigns enable row level security;
-- No policies: backend only.
create index if not exists email_campaigns_due_idx on public.email_campaigns (status, scheduled_at);

-- One row per recipient — makes sending idempotent and resumable (a crash mid-send never
-- emails anyone twice).
create table if not exists public.email_campaign_sends (
  campaign_id uuid not null references public.email_campaigns (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  error text,
  sent_at timestamptz,
  primary key (campaign_id, user_id)
);
alter table public.email_campaign_sends enable row level security;
-- No policies: backend only.

-- ── CRM ────────────────────────────────────────────────────────────────────
create table if not exists public.crm_stages (
  id text primary key,
  name text not null,
  position int not null default 0,
  outcome text not null default 'open' check (outcome in ('open', 'won', 'lost')),
  color text not null default '#8a8f98'
);
alter table public.crm_stages enable row level security;
-- No policies: backend only.

insert into public.crm_stages (id, name, position, outcome, color) values
  ('new', 'New', 0, 'open', '#8a8f98'),
  ('contacted', 'Contacted', 1, 'open', '#4f8cff'),
  ('qualified', 'Qualified', 2, 'open', '#a855f7'),
  ('proposal', 'Proposal', 3, 'open', '#ffb547'),
  ('won', 'Won', 4, 'won', '#34d399'),
  ('lost', 'Lost', 5, 'lost', '#ff6b6b')
on conflict (id) do nothing;

create table if not exists public.crm_contacts (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'lead' check (kind in ('lead', 'client')),
  name text not null,
  email text,
  phone text,
  company text,
  source text not null default '',
  stage_id text not null default 'new' references public.crm_stages (id),
  owner_id uuid references auth.users (id) on delete set null,
  value numeric(14, 2) not null default 0,
  currency text not null default 'INR',
  tags text[] not null default '{}',
  notes text not null default '',
  user_id uuid references auth.users (id) on delete set null,
  last_activity_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.crm_contacts enable row level security;
-- No policies: backend only.
create index if not exists crm_contacts_stage_idx on public.crm_contacts (stage_id, last_activity_at desc);
create index if not exists crm_contacts_email_idx on public.crm_contacts (lower(email));

create table if not exists public.crm_activities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.crm_contacts (id) on delete cascade,
  kind text not null default 'note' check (kind in ('note', 'call', 'email', 'meeting', 'stage_change', 'system')),
  body text not null default '',
  meta jsonb not null default '{}'::jsonb,
  author_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.crm_activities enable row level security;
-- No policies: backend only.
create index if not exists crm_activities_contact_idx on public.crm_activities (contact_id, created_at desc);

-- ── Support center ─────────────────────────────────────────────────────────
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  number bigserial unique,
  user_id uuid references auth.users (id) on delete set null,
  email text not null,
  name text not null default '',
  subject text not null,
  status text not null default 'open' check (status in ('open', 'pending', 'resolved', 'closed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  category text not null default 'general',
  channel text not null default 'app' check (channel in ('app', 'email', 'web', 'console')),
  assignee_id uuid references auth.users (id) on delete set null,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.support_tickets enable row level security;
-- No policies: backend only.
create index if not exists support_tickets_queue_idx on public.support_tickets (status, last_message_at desc);
create index if not exists support_tickets_user_idx on public.support_tickets (user_id, created_at desc);

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets (id) on delete cascade,
  author_type text not null check (author_type in ('user', 'staff', 'system')),
  author_id uuid references auth.users (id) on delete set null,
  body text not null,
  internal boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.support_messages enable row level security;
-- No policies: backend only.
create index if not exists support_messages_ticket_idx on public.support_messages (ticket_id, created_at);

-- ── Shared team tasks ──────────────────────────────────────────────────────
create table if not exists public.staff_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assignee_id uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  due_at timestamptz,
  related_type text check (related_type in ('ticket', 'contact')),
  related_id uuid,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.staff_tasks enable row level security;
-- No policies: backend only.
create index if not exists staff_tasks_assignee_idx on public.staff_tasks (assignee_id, status);

-- ── Directory functions (service role only) ────────────────────────────────
-- profiles has no email column; these join auth.users so the console can search users, look one
-- up by email, and walk a campaign audience in keyset pages (scales past any single page size).
create or replace function public.console_user_directory(p_search text default null, p_limit int default 50, p_offset int default 0)
returns table (
  id uuid, email text, full_name text, plan text, role text, created_at timestamptz,
  last_sign_in_at timestamptz, marketing_opt_out boolean, banned_until timestamptz
)
language sql
security definer
set search_path = public, auth
as $$
  select u.id, u.email::text, p.full_name, coalesce(p.plan, 'free'), coalesce(p.role, 'user'), u.created_at,
         u.last_sign_in_at, coalesce(p.marketing_opt_out, false), u.banned_until
  from auth.users u
  left join public.profiles p on p.id = u.id
  where p_search is null or p_search = ''
     or u.email ilike '%' || p_search || '%'
     or p.full_name ilike '%' || p_search || '%'
  order by u.created_at desc
  limit least(greatest(p_limit, 1), 500) offset greatest(p_offset, 0);
$$;
revoke all on function public.console_user_directory(text, int, int) from public, anon, authenticated;
grant execute on function public.console_user_directory(text, int, int) to service_role;

create or replace function public.console_campaign_audience(p_audience text, p_new_since timestamptz, p_after uuid default null, p_limit int default 500)
returns table (id uuid, email text, full_name text)
language sql
security definer
set search_path = public, auth
as $$
  select u.id, u.email::text, p.full_name
  from auth.users u
  left join public.profiles p on p.id = u.id
  where u.email is not null
    and not coalesce(p.marketing_opt_out, false)
    and (p_after is null or u.id > p_after)
    and case p_audience
      when 'all' then true
      when 'free' then coalesce(p.plan, 'free') = 'free'
      when 'paid' then coalesce(p.plan, 'free') <> 'free'
      when 'pro' then p.plan = 'pro'
      when 'premium' then p.plan = 'premium'
      when 'new_users' then u.created_at >= p_new_since
      else false
    end
  order by u.id
  limit least(greatest(p_limit, 1), 1000);
$$;
revoke all on function public.console_campaign_audience(text, timestamptz, uuid, int) from public, anon, authenticated;
grant execute on function public.console_campaign_audience(text, timestamptz, uuid, int) to service_role;
