-- Build checkpoints: the project's files as they were right before each Build agent turn, so the user
-- can "Restore to before this message" (files and conversation rewind to that point).
create table if not exists public.build_checkpoints (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- The user message that started the turn; deleting it (a restore rewinds past it) drops the checkpoint.
  message_id uuid not null references public.messages(id) on delete cascade,
  files jsonb not null default '{}'::jsonb,
  start_cmd text,
  port integer,
  created_at timestamptz not null default now()
);

create index if not exists build_checkpoints_conversation_idx on public.build_checkpoints (conversation_id, created_at desc);
create unique index if not exists build_checkpoints_message_idx on public.build_checkpoints (message_id);

-- No policies: backend only
alter table public.build_checkpoints enable row level security;
