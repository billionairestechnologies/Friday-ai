-- Library: every code block / page / image an assistant reply produces is saved here
-- automatically (see backend services/libraryService.ts) so it can be browsed by category,
-- reused or downloaded from web, Android and iOS. Users can delete items; deletes are soft
-- (deleted_at) so the one-time backfill of old chats never resurrects something they removed.
create table if not exists public.library_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  message_id uuid not null,
  idx int not null,
  title text not null,
  kind text not null,
  lang text,
  category text not null,
  content text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (message_id, idx)
);
create index if not exists library_items_user_idx on public.library_items (user_id, created_at desc);
alter table public.library_items enable row level security;
-- No policies: only the backend (service role) reads/writes this table.
