-- 0062 One-time popups done properly + the notification inbox (docs/product/V3_PROGRAM.md, phase 05).
--
-- Before: closing the What's New carousel marked EVERY item seen, including ones never scrolled to,
-- two open tabs could both show the same popup, and there was no way to show a changed update again.
--
-- Now (announcements):
--   * version: "publish as a new version" bumps it; each version is shown at most once per person.
--   * Display is CLAIMED atomically (announcement_claim): the first tab/device to claim shows it,
--     every other one gets claimed=false and skips it. Nothing is marked before it is displayed.
--   * State per person and version only moves forward: displayed → dismissed | acknowledged | clicked.
--   * priority, variant (modal | banner), accent, icon, a second CTA — presentation, all allow-listed.
--
-- user_notifications (0060) become the inbox; `popup` ones (benefits granted) are also shown once,
-- claimed the same way (displayed_at), and acknowledged by the person.

alter table public.announcements
  add column if not exists version int not null default 1,
  add column if not exists priority int not null default 0,
  add column if not exists variant text not null default 'modal',
  add column if not exists accent text not null default 'default',
  add column if not exists icon text not null default 'sparkles',
  add column if not exists cta2_label text,
  add column if not exists cta2_url text;
do $$ begin
  alter table public.announcements add constraint announcements_variant_check check (variant in ('modal', 'banner'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.announcements add constraint announcements_accent_check check (accent in ('default', 'blue', 'green', 'amber', 'purple', 'red'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.announcements add constraint announcements_icon_check check (icon in ('sparkles', 'rocket', 'gift', 'wrench', 'shield', 'megaphone', 'graduation'));
exception when duplicate_object then null; end $$;

alter table public.announcement_views
  add column if not exists version int not null default 1,
  add column if not exists state text not null default 'acknowledged',
  add column if not exists platform text,
  add column if not exists displayed_at timestamptz,
  add column if not exists acted_at timestamptz;
do $$ begin
  alter table public.announcement_views add constraint announcement_views_state_check check (state in ('displayed', 'dismissed', 'acknowledged', 'clicked'));
exception when duplicate_object then null; end $$;
-- One row per person per VERSION (was per announcement).
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'announcement_views_pkey'
             and pg_get_constraintdef(oid) not like '%version%') then
    alter table public.announcement_views drop constraint announcement_views_pkey;
    alter table public.announcement_views add constraint announcement_views_pkey primary key (announcement_id, user_id, version);
  end if;
end $$;

-- Claims the right to show one version to one person. true = show it now; false = already shown
-- (another tab, another device, or earlier).
create or replace function public.announcement_claim(p_announcement uuid, p_user uuid, p_version int, p_platform text, p_now timestamptz default now())
returns boolean language plpgsql as $$
declare
  v_inserted int;
begin
  insert into public.announcement_views (announcement_id, user_id, version, state, platform, displayed_at, seen_at)
    values (p_announcement, p_user, p_version, 'displayed', p_platform, p_now, p_now)
    on conflict do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end $$;

-- Records what the person did with a displayed popup. Never moves backwards, never re-opens it.
create or replace function public.announcement_act(p_announcement uuid, p_user uuid, p_version int, p_state text, p_now timestamptz default now())
returns void language plpgsql as $$
begin
  if p_state not in ('dismissed', 'acknowledged', 'clicked') then raise exception 'bad_state'; end if;
  update public.announcement_views set
    state = case
      when p_state = 'clicked' then 'clicked'
      when state = 'displayed' then p_state
      else state end,
    clicked = clicked or p_state = 'clicked',
    acted_at = coalesce(acted_at, p_now)
  where announcement_id = p_announcement and user_id = p_user and version = p_version;
end $$;

alter table public.user_notifications
  add column if not exists popup boolean not null default false,
  add column if not exists displayed_at timestamptz;
create index if not exists user_notifications_unread_idx on public.user_notifications (user_id) where seen_at is null;
-- Benefits already granted before this migration become popups too (they were never shown).
update public.user_notifications set popup = true where kind in ('credit_granted', 'program_approved') and acknowledged_at is null and not popup;

-- Claims a notification popup for display (once, across tabs and devices).
create or replace function public.notification_claim(p_notification uuid, p_user uuid, p_now timestamptz default now())
returns boolean language plpgsql as $$
declare
  v_updated int;
begin
  update public.user_notifications set displayed_at = p_now, seen_at = coalesce(seen_at, p_now)
    where id = p_notification and user_id = p_user and popup and displayed_at is null;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'announcement_claim(uuid, uuid, int, text, timestamptz)',
    'announcement_act(uuid, uuid, int, text, timestamptz)',
    'notification_claim(uuid, uuid, timestamptz)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%s from authenticated', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', fn); end if;
  end loop;
end $$;
