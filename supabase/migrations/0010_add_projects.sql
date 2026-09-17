create table if not exists public.assistant_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  mode text not null default 'work' check (mode in ('personal', 'work', 'developer')),
  instructions text not null default '',
  repository_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.conversations
  add column if not exists project_id uuid references public.assistant_projects (id) on delete set null;

alter table public.assistant_projects enable row level security;

drop policy if exists "assistant_projects: owner full access" on public.assistant_projects;
create policy "assistant_projects: owner full access" on public.assistant_projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists assistant_projects_user_updated_idx
  on public.assistant_projects (user_id, updated_at desc);
create index if not exists conversations_project_id_idx
  on public.conversations (project_id);
