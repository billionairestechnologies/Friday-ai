-- Push notification endpoints per device, so a finished reply can reach a user whose web tab /
-- Android app / iOS app is closed (generation now continues server-side after disconnect).
-- `token` is the FCM registration token (android/ios) or the Web Push endpoint URL (web);
-- `keys` carries the Web Push p256dh/auth pair and is null for FCM.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null check (platform in ('web', 'android', 'ios')),
  token text not null unique,
  keys jsonb,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
-- No policies: only the backend (service role) reads/writes this table.
