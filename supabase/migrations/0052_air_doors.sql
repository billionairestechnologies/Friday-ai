-- Air Dots doors: passphrase for pay/send/delete, channel links, in-app calls.
alter table public.profiles add column if not exists air_passphrase_hash text;

create table if not exists public.air_channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'telegram')),
  external_id text not null,
  created_at timestamptz not null default now(),
  unique (channel, external_id)
);

create table if not exists public.air_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  status text not null default 'open' check (status in ('open', 'ended')),
  created_at timestamptz not null default now()
);

alter table public.air_channels enable row level security;
alter table public.air_calls enable row level security;
