-- Build Mode: the chat agent can create a real multi-file project in a per-conversation E2B
-- sandbox (write files, install dependencies, run a dev server) and show a live preview.
-- build_projects remembers the sandbox + a text snapshot of the project's files so a preview can
-- be restored in a fresh sandbox after the old one expires (they're short-lived).
create table if not exists public.build_projects (
  conversation_id uuid primary key references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  sandbox_id text,
  start_cmd text,
  port int,
  files jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.build_projects enable row level security;
-- No policies: only the backend (service role) reads/writes this table.

-- Steps ("Ran command · Install dependencies", "Wrote src/App.jsx"…) and the preview URL of the
-- turn that built something, so the chat still shows them after a reload / on another device.
alter table public.messages add column if not exists build jsonb;
