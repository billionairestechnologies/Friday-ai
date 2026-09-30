-- Build event log: every stream event of the CURRENT Build agent turn, in order, so a device that
-- wasn't connected (reload, another phone) can replay the turn and keep following it live.
-- Bounded: a conversation's previous turn's events are cleared when a new turn starts; the finished
-- result lives on the message itself (messages.build).
create table if not exists public.build_events (
  id bigserial primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists build_events_conversation_idx on public.build_events (conversation_id, id);

-- No policies: backend only
alter table public.build_events enable row level security;
