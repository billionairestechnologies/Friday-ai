-- Preserve the visible shape of a conversation across reloads and devices.
alter table public.messages
  add column if not exists thinking text,
  add column if not exists citations jsonb not null default '[]'::jsonb,
  add column if not exists agents jsonb not null default '[]'::jsonb,
  add column if not exists used_think boolean not null default false,
  add column if not exists used_search boolean not null default false,
  add column if not exists used_canvas boolean not null default false,
  add column if not exists error text;

create table if not exists public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  name text not null default 'attachment',
  mime text not null,
  size_bytes int not null default 0,
  kind text not null default 'file' check (kind in ('image', 'file')),
  data_url text not null,
  created_at timestamptz not null default now()
);

alter table public.message_attachments enable row level security;

drop policy if exists "message_attachments: owner full access" on public.message_attachments;
create policy "message_attachments: owner full access" on public.message_attachments
  for all using (
    exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_id and c.user_id = auth.uid()
    )
  );

create index if not exists message_attachments_message_id_idx
  on public.message_attachments (message_id);
