-- Friday AI: initial schema
-- Run in the Supabase SQL editor, or via `supabase db push`.

-- ─────────────────────────────────────────────────────────────────────────
-- profiles: one row per auth.users, carries display name + app role
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: user can read own row" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles: user can update own row" on public.profiles
  for update using (auth.uid() = id);

create policy "profiles: admin can read all" on public.profiles
  for select using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- Auto-create a profile whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────────────
-- providers: the fixed list of AI providers Friday AI knows how to call
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.providers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  base_url text,
  created_at timestamptz not null default now()
);

insert into public.providers (slug, display_name, base_url) values
  ('openai', 'OpenAI', 'https://api.openai.com/v1'),
  ('anthropic', 'Anthropic', 'https://api.anthropic.com/v1'),
  ('gemini', 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta'),
  ('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'),
  ('sarvam', 'Sarvam AI', 'https://api.sarvam.ai'),
  ('elevenlabs', 'ElevenLabs', 'https://api.elevenlabs.io/v1'),
  ('ollama', 'Ollama (local)', 'http://localhost:11434')
on conflict (slug) do nothing;

alter table public.providers enable row level security;

create policy "providers: anyone signed in can read" on public.providers
  for select using (auth.role() = 'authenticated');

-- ─────────────────────────────────────────────────────────────────────────
-- provider_api_keys: admin-managed, encrypted at rest by the backend
-- (the DB only ever stores ciphertext + a masked preview, never plaintext)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.provider_api_keys (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  label text not null default 'default',
  encrypted_key text not null,
  masked_preview text not null,
  is_active boolean not null default true,
  is_working boolean,
  last_checked_at timestamptz,
  last_error text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

alter table public.provider_api_keys enable row level security;

create policy "provider_api_keys: admin only" on public.provider_api_keys
  for all using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ─────────────────────────────────────────────────────────────────────────
-- provider_models: auto-discovered per provider when a key is added;
-- admin toggles which ones are shown to users in the model selector
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.provider_models (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers (id) on delete cascade,
  model_id text not null,
  display_name text not null,
  capabilities jsonb not null default '{"chat": true}'::jsonb,
  is_enabled_for_users boolean not null default false,
  discovered_at timestamptz not null default now(),
  unique (provider_id, model_id)
);

alter table public.provider_models enable row level security;

create policy "provider_models: users read enabled models" on public.provider_models
  for select using (
    is_enabled_for_users = true
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create policy "provider_models: admin writes" on public.provider_models
  for all using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ─────────────────────────────────────────────────────────────────────────
-- conversations + messages
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null default 'New chat',
  provider_id uuid references public.providers (id),
  model_id text,
  -- 'single' talks to one chosen provider+model; 'auto' picks a working model per message
  -- with fallback; 'teamup' fans a message out to several models and shows every reply.
  mode text not null default 'single' check (mode in ('single', 'auto', 'teamup')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.conversations enable row level security;

create policy "conversations: owner full access" on public.conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  input_mode text not null default 'text' check (input_mode in ('text', 'voice')),
  -- which model actually produced this reply, e.g. "Anthropic — Claude Sonnet" (auto/teamup modes
  -- can answer with a different or several models, so replies are attributed individually).
  model_label text,
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;

create policy "messages: owner full access" on public.messages
  for all using (
    exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid())
  );

create index if not exists messages_conversation_id_idx on public.messages (conversation_id, created_at);
create index if not exists conversations_user_id_idx on public.conversations (user_id, updated_at desc);
create index if not exists provider_models_provider_id_idx on public.provider_models (provider_id);
create index if not exists provider_api_keys_provider_id_idx on public.provider_api_keys (provider_id);
