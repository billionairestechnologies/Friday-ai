-- Build Mode workspace: execution modes (how much approval the agent needs before acting),
-- an effort budget (how many iterations/QA rounds it gets), and support for fanning a build out
-- into parallel sub-agents (e.g. one for backend, one for frontend) that a coordinator merges.
alter table public.build_projects
  add column if not exists mode text not null default 'auto'
    check (mode in ('manual', 'edit_auto', 'plan', 'auto')),
  add column if not exists effort text not null default 'medium'
    check (effort in ('low', 'medium', 'high')),
  add column if not exists pending_approval jsonb,
  add column if not exists plan_approved boolean not null default false;

create table if not exists public.build_subtasks (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.build_projects (conversation_id) on delete cascade,
  name text not null,
  workdir text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'error', 'merged')),
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.build_subtasks enable row level security;
-- No policies: only the backend (service role) reads/writes this table.
