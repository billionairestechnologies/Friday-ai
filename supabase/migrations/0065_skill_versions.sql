-- 0065 Power Skills: versioned manifests, declared capabilities, evals (docs/product/V3_PROGRAM.md, phase 10).
--
-- A user skill now has a status (draft | published | disabled), a version, the CAPABILITIES it may
-- use (groups of real tools — enforced by the tool loop, not by the skill's own text) and eval cases.
-- Every publish is an immutable row in skill_versions; a rollback publishes an old version as a new
-- one, so history is never rewritten. Eval runs are recorded per version; publishing requires the
-- latest run of the draft to pass when the skill has eval cases (services/skills/manifest.ts).

alter table public.user_skills
  add column if not exists status text not null default 'published',
  add column if not exists version int not null default 1,
  add column if not exists capabilities text[],
  add column if not exists evals jsonb not null default '[]'::jsonb,
  add column if not exists changelog text not null default '',
  add column if not exists draft jsonb;
do $$ begin
  alter table public.user_skills add constraint user_skills_status_check check (status in ('draft', 'published', 'disabled'));
exception when duplicate_object then null; end $$;

create table if not exists public.skill_versions (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references public.user_skills (id) on delete cascade,
  version int not null check (version >= 1),
  manifest jsonb not null,
  changelog text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (skill_id, version)
);
-- No policies: backend only
alter table public.skill_versions enable row level security;

create table if not exists public.skill_eval_runs (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references public.user_skills (id) on delete cascade,
  manifest_hash text not null,
  passed int not null,
  total int not null,
  results jsonb not null,
  created_at timestamptz not null default now()
);
-- No policies: backend only
alter table public.skill_eval_runs enable row level security;
create index if not exists skill_eval_runs_skill_idx on public.skill_eval_runs (skill_id, created_at desc);

-- Existing skills become version 1 of a published skill (their capabilities stay null = the safe default set).
insert into public.skill_versions (skill_id, version, manifest, changelog)
select s.id, 1, jsonb_build_object('name', s.name, 'description', s.description, 'instructions', s.instructions, 'icon', s.icon, 'capabilities', null, 'evals', '[]'::jsonb), 'Initial version'
from public.user_skills s
where not exists (select 1 from public.skill_versions v where v.skill_id = s.id);
