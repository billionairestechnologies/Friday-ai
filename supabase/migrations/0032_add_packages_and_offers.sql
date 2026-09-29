-- ─────────────────────────────────────────────────────────────────────────
-- Plans & Offers (Team Console): hand-built packages for enterprises and
-- individuals, offer codes (plan grants, package grants, checkout discounts),
-- student passes and other eligibility-gated offers with a review queue, and
-- an auditable history of every access grant with its expiry.
--
-- These sit ON TOP of the existing limits model — a grant writes the same
-- profiles.plan / plan_renews_at / custom_monthly_cap and organizations.plan /
-- seat_count / pooled_monthly_tokens columns the quota system already reads.
-- Backend only: RLS on, no policies.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.plan_packages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  target text not null default 'individual' check (target in ('individual', 'organization')),
  plan text not null check (plan in ('free', 'pro', 'premium', 'enterprise')),
  monthly_token_cap bigint,
  seats int,
  pooled_monthly_tokens bigint,
  duration_days int check (duration_days is null or duration_days > 0),
  price_paise bigint not null default 0,
  currency text not null default 'INR',
  features text[] not null default '{}',
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.plan_packages enable row level security;
-- No policies: backend only.

create table if not exists public.offers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text not null default '',
  kind text not null check (kind in ('plan_grant', 'package', 'discount')),
  plan text check (plan in ('pro', 'premium')),
  package_id uuid references public.plan_packages (id) on delete set null,
  duration_days int check (duration_days is null or duration_days > 0),
  discount_percent int check (discount_percent is null or (discount_percent between 1 and 100)),
  applies_to_plans text[] not null default '{pro,premium}',
  eligibility text not null default 'anyone' check (eligibility in ('anyone', 'new_users', 'email_domain', 'student')),
  email_domains text[] not null default '{}',
  requires_approval boolean not null default false,
  max_redemptions int check (max_redemptions is null or max_redemptions > 0),
  redemption_count int not null default 0,
  starts_at timestamptz,
  expires_at timestamptz,
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.offers enable row level security;
-- No policies: backend only.

create table if not exists public.offer_redemptions (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.offers (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'applied' check (status in ('pending', 'applied', 'rejected')),
  proof text not null default '',
  note text not null default '',
  order_id text,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (offer_id, user_id)
);
alter table public.offer_redemptions enable row level security;
-- No policies: backend only.
create index if not exists offer_redemptions_pending_idx on public.offer_redemptions (status, created_at);

create table if not exists public.access_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete cascade,
  source text not null check (source in ('manual', 'package', 'offer')),
  package_id uuid references public.plan_packages (id) on delete set null,
  offer_id uuid references public.offers (id) on delete set null,
  plan text not null,
  monthly_token_cap bigint,
  seats int,
  pooled_monthly_tokens bigint,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  note text not null default '',
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (user_id is not null or organization_id is not null)
);
alter table public.access_grants enable row level security;
-- No policies: backend only.
create index if not exists access_grants_expiry_idx on public.access_grants (status, ends_at);
create index if not exists access_grants_user_idx on public.access_grants (user_id, created_at desc);

-- New console permissions for the built-in roles (owners/admins already have "*").
update public.staff_roles set permissions = array_append(permissions, 'plans.manage')
  where id = 'operations' and not ('plans.manage' = any (permissions));
update public.staff_roles set permissions = array_append(permissions, 'plans.view')
  where id in ('sales', 'support', 'marketing') and not ('plans.view' = any (permissions));
update public.staff_roles set permissions = array_append(permissions, 'plans.review')
  where id = 'support' and not ('plans.review' = any (permissions));
