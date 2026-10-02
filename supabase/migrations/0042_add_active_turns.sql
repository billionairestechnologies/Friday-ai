-- Background turns: every chat / research / Build turn that is being generated, durable across
-- devices, instances and restarts.
--
-- Before this, "is this conversation still generating?" lived in one server process's memory: a
-- second instance (or the same one after a deploy) didn't know, the Stop button only worked when it
-- reached the right instance, and a deploy in the middle of a 30-minute build silently killed it.
-- Each running turn now heartbeats here; a turn whose heartbeat stops is picked up by another
-- instance (Build continues from the project's saved state) or reported as interrupted.
create table if not exists public.active_turns (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('chat', 'research', 'build')),
  -- What the turn was asked, for an automatic resume (no attachments — those stay with the message).
  request jsonb not null default '{}'::jsonb,
  instance_id text not null,
  status text not null default 'running' check (status in ('running', 'resuming')),
  stop_requested boolean not null default false,
  resume_count integer not null default 0,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now()
);

create index if not exists active_turns_heartbeat_idx on public.active_turns (heartbeat_at);
create index if not exists active_turns_user_idx on public.active_turns (user_id);

-- No policies: backend only
alter table public.active_turns enable row level security;
