-- Pages: live documents, spreadsheets and slide decks the user edits in place, Friday writes into,
-- and the user can share by link — instead of only downloadable files. Each save keeps a version so
-- any edit (the user's or Friday's) can be looked at and restored. Exports to .docx/.pdf/.md,
-- .xlsx/.csv and .pptx reuse the document renderer.
create table if not exists public.pages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  kind text not null check (kind in ('doc', 'sheet', 'slides')),
  title text not null default 'Untitled',
  -- doc: {"markdown": "..."}; sheet: {"sheets": [{"name", "columns", "rows"}]}; slides: {"slides": [...], "theme_color"}
  content jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  share_token text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists pages_user_idx on public.pages (user_id, updated_at desc) where deleted_at is null;

-- No policies: backend only
alter table public.pages enable row level security;

create table if not exists public.page_versions (
  id bigserial primary key,
  page_id uuid not null references public.pages(id) on delete cascade,
  version integer not null,
  title text not null,
  content jsonb not null,
  author text not null default 'user' check (author in ('user', 'friday')),
  created_at timestamptz not null default now(),
  unique (page_id, version)
);

-- No policies: backend only
alter table public.page_versions enable row level security;

-- Pages created in a chat show as cards under the reply that made them: they ride the existing
-- messages.files list (format "page"), so no message-table change is needed.
