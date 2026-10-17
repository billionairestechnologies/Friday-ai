-- 0068 Sessions & devices (docs/product/V3_PROGRAM.md, phase 11).
--
-- One row per signed-in app session (web, Android, iOS), keyed by the Supabase Auth session id in
-- the access token (`session_id` claim). FridayX CLI/IDE sign-ins already live in cli_tokens (0050);
-- the Sessions page shows both. requireAuth touches the row (≤ once a minute per session) and a
-- revoked session gets 401 immediately; revoking also deletes the auth.sessions row so its refresh
-- token dies with it.
--
-- Device limit: the `maxDevices` plan entitlement. 0 (the default on every plan) = no limit, so
-- nothing changes until the team sets one in Console → Plans. When set, a NEW session beyond the
-- limit signs out the person's least-recently-used session (reason 'device_limit') — the newest
-- sign-in always wins, so nobody is locked out of the device in their hand.
-- Privacy: only a coarse IP prefix (a.b.c.x / first 3 IPv6 groups) is kept, never the full address.

create table if not exists public.user_sessions (
  id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  platform text not null default 'web' check (platform in ('web', 'android', 'ios', 'other')),
  client text not null default '',
  ip_prefix text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or revoked_reason in ('user', 'user_others', 'admin', 'device_limit'))
);
-- No policies: backend only
alter table public.user_sessions enable row level security;
create index if not exists user_sessions_active_idx on public.user_sessions (user_id, last_seen_at desc) where revoked_at is null;

-- Ends one session: marks it revoked and (when Supabase Auth is present) deletes its auth session so
-- the refresh token can't mint a new access token. Idempotent; true if it was active.
create or replace function public.session_revoke(p_session uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.user_sessions set revoked_at = now(), revoked_reason = p_reason where id = p_session and revoked_at is null;
  get diagnostics n = row_count;
  if to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where id = $1' using p_session;
  end if;
  return n > 0;
end $$;

-- Records that a session was used. Returns 'ok' or 'revoked'. A brand-new session over the
-- person's device limit (p_max > 0) signs out their least-recently-used other sessions.
create or replace function public.session_touch(p_session uuid, p_user uuid, p_platform text, p_client text, p_ip text, p_max int)
returns text language plpgsql security definer set search_path = public as $$
declare
  existing record;
  victim record;
begin
  select user_id, revoked_at into existing from public.user_sessions where id = p_session;
  if found then
    if existing.user_id <> p_user or existing.revoked_at is not null then return 'revoked'; end if;
    update public.user_sessions set last_seen_at = now(), client = coalesce(nullif(p_client, ''), client), ip_prefix = coalesce(p_ip, ip_prefix) where id = p_session;
    return 'ok';
  end if;
  -- New session: serialise per person so two simultaneous sign-ins can't both slip under the limit.
  perform 1 from public.profiles where id = p_user for update;
  insert into public.user_sessions (id, user_id, platform, client, ip_prefix)
  values (p_session, p_user, case when p_platform in ('web', 'android', 'ios') then p_platform else 'other' end, coalesce(p_client, ''), p_ip)
  on conflict (id) do nothing;
  if coalesce(p_max, 0) > 0 then
    for victim in
      select id from public.user_sessions
      where user_id = p_user and revoked_at is null and id <> p_session
      order by last_seen_at desc
      offset greatest(p_max - 1, 0)
    loop
      perform public.session_revoke(victim.id, 'device_limit');
    end loop;
  end if;
  return 'ok';
end $$;

-- Active sessions for the Sessions page. Rows whose auth session is gone (a normal sign-out, an
-- expired refresh token) are left out, so the list only shows devices that can still act.
create or replace function public.session_list(p_user uuid)
returns table (id uuid, platform text, client text, ip_prefix text, created_at timestamptz, last_seen_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if to_regclass('auth.sessions') is not null then
    return query execute
      'select s.id, s.platform, s.client, s.ip_prefix, s.created_at, s.last_seen_at
         from public.user_sessions s
        where s.user_id = $1 and s.revoked_at is null and exists (select 1 from auth.sessions a where a.id = s.id)
        order by s.last_seen_at desc'
      using p_user;
  else
    return query
      select s.id, s.platform, s.client, s.ip_prefix, s.created_at, s.last_seen_at
        from public.user_sessions s
       where s.user_id = p_user and s.revoked_at is null
       order by s.last_seen_at desc;
  end if;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array['session_revoke(uuid, text)', 'session_touch(uuid, uuid, text, text, text, int)', 'session_list(uuid)'] loop
    execute format('revoke all on function public.%s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%s from authenticated', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', fn); end if;
  end loop;
end $$;
