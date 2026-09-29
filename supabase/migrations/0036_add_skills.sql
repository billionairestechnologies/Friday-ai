-- ─────────────────────────────────────────────────────────────────────────
-- Skills: reusable expert playbooks the agent loads when a request matches
-- (or the user picks one). Built-in skills live in code
-- (backend/src/services/skills/catalog.ts); this stores the skills users write
-- themselves and which built-ins each user has switched off.
-- Backend only: RLS on, no policies.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.user_skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 2 and 60),
  description text not null default '' check (char_length(description) <= 300),
  instructions text not null check (char_length(instructions) between 20 and 12000),
  icon text not null default '✨',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.user_skills enable row level security;
-- No policies: backend only.
create index if not exists user_skills_user_idx on public.user_skills (user_id, created_at desc);

-- Per-user on/off for built-in skills (absent row = the built-in's default: on).
create table if not exists public.user_skill_prefs (
  user_id uuid not null references auth.users (id) on delete cascade,
  skill_id text not null,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, skill_id)
);
alter table public.user_skill_prefs enable row level security;
-- No policies: backend only.
