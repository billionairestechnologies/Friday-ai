-- Long-term memory: short facts about the user ("prefers TypeScript", "works at Acme", "my
-- daughter's name is Ria") that Friday carries into every new chat. Saved when the user asks
-- Friday to remember something (the `remember` tool) and viewable/deletable from Settings.
create table if not exists public.user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  content text not null check (char_length(content) between 1 and 500),
  source_conversation_id uuid references public.conversations (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists user_memories_user_idx on public.user_memories (user_id, created_at);
alter table public.user_memories enable row level security;
-- No policies: only the backend (service role) reads/writes this table.
