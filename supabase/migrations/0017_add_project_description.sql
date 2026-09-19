alter table public.assistant_projects
  add column if not exists description text not null default '';
