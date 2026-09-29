-- ─────────────────────────────────────────────────────────────────────────
-- Generated documents: presentations, spreadsheets, Word documents, PDFs and
-- text formats (Markdown, XML, CSV, JSON, HTML) that Friday creates when a
-- user asks (agent tool create_document). Bytes live in Supabase Storage
-- (bucket "generated-files", created by the backend on first use) or, when
-- object storage is off, inline as base64. Each is owned by one user and
-- shows up in their Library; deletes are soft so history stays consistent.
-- Backend only: RLS on, no policies.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.generated_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  format text not null check (format in ('pptx', 'xlsx', 'docx', 'pdf', 'md', 'xml', 'csv', 'json', 'html', 'txt')),
  title text not null,
  filename text not null,
  mime text not null,
  size_bytes bigint not null default 0,
  summary text not null default '',
  storage_bucket text,
  storage_path text,
  content_b64 text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.generated_files enable row level security;
-- No policies: backend only.
create index if not exists generated_files_user_idx on public.generated_files (user_id, created_at desc) where deleted_at is null;

-- Files a reply produced, shown as download cards under the message: [{id, title, filename, format, size}].
alter table public.messages add column if not exists files jsonb not null default '[]'::jsonb;
