-- Build secrets vault: per-project environment variables (API keys etc.), encrypted at rest with
-- utils/crypto.ts. They're injected into the sandbox as env vars for the project's commands and never
-- shown to the model: values are redacted from any output before the model or the user sees it.
create table if not exists public.build_secrets (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  name text not null check (name ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  value_encrypted text not null,
  updated_at timestamptz not null default now(),
  primary key (conversation_id, name)
);

-- No policies: backend only
alter table public.build_secrets enable row level security;
