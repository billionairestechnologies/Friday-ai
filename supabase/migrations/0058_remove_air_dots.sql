-- ─────────────────────────────────────────────────────────────────────────
-- Remove Air Dots, Friday on the phone, and the WhatsApp/Telegram doors.
--
-- allow-destructive-migration: the owner parked the always-on agent on 2026-10-17 to focus on
-- Friday, FridayX and the IDE, and asked for its data to be removed from the server too. The code
-- was removed from v3 in the same change. Run this only AFTER the v3 image is live (the v2 image
-- never reads these objects, so it is also safe while v2 is still running), and only after a dump:
--
--   pg_dump -t 'public.air_*' -t public.browser_sessions -t 'public.phone_*' \
--           --column-inserts friday > /opt/backup-air-dots-<date>.sql
--
-- What is dropped (created by 0051, 0052, 0053, 0056):
--   tables    air_channels, air_calls, air_jobs, air_dots, air_actions, air_approvals, air_machines,
--             browser_sessions (Air Dots' cross-instance machine registry), phone_settings,
--             phone_preferences, phone_minutes
--   function  air_add_call_seconds
--   columns   profiles.air_passphrase_hash / air_passphrase_failures / air_passphrase_locked_until /
--             phone_last10, conversations.origin, announcements.featured
-- Also dropped: v3's plan-schedule columns (0054: profiles.scheduled_plan*) — 0057 already copied
-- any booked plan into quota_accounts.pending_plan. Kept on purpose: plan_reminders (0055),
-- profiles_plan_renews_at_idx (the expiry sweep uses it), and every chat that was started in Air
-- Dots (the conversations stay as ordinary chats; only their origin marker goes).
-- Safe to run twice. No policies: backend only.
-- ─────────────────────────────────────────────────────────────────────────

drop function if exists public.air_add_call_seconds(uuid, text, int);

drop table if exists public.air_approvals;
drop table if exists public.air_actions;
drop table if exists public.air_jobs;
drop table if exists public.air_dots;
drop table if exists public.air_calls;
drop table if exists public.air_channels;
drop table if exists public.air_machines;
drop table if exists public.browser_sessions;
drop table if exists public.phone_minutes;
drop table if exists public.phone_preferences;
drop table if exists public.phone_settings;

drop index if exists public.profiles_phone_last10_idx;
alter table public.profiles
  drop column if exists phone_last10,
  drop column if exists air_passphrase_hash,
  drop column if exists air_passphrase_failures,
  drop column if exists air_passphrase_locked_until,
  drop column if exists scheduled_plan,
  drop column if exists scheduled_plan_days,
  drop column if exists scheduled_plan_order_id;

alter table public.conversations drop constraint if exists conversations_origin_check;
alter table public.conversations drop column if exists origin;

alter table public.announcements drop column if exists featured;
-- Updates that were only for Air Dots / WhatsApp / Telegram are archived; mixed ones keep their app platforms.
update public.announcements set status = 'archived'
  where not (platforms && array['web', 'android', 'ios']::text[]);
update public.announcements
  set platforms = array(select x from unnest(platforms) x where x in ('web', 'android', 'ios'))
  where platforms && array['air', 'whatsapp', 'telegram']::text[] and platforms && array['web', 'android', 'ios']::text[];

-- Air Dots switches some admins saved on plans, packages, grants, people or organizations.
update public.plan_catalog set entitlements = entitlements - 'airDots' - 'airCallMinutes' - 'airAwakeMinutes' where entitlements ?| array['airDots', 'airCallMinutes', 'airAwakeMinutes'];
update public.plan_packages set entitlements = entitlements - 'airDots' - 'airCallMinutes' - 'airAwakeMinutes' where entitlements ?| array['airDots', 'airCallMinutes', 'airAwakeMinutes'];
update public.access_grants set entitlements = entitlements - 'airDots' - 'airCallMinutes' - 'airAwakeMinutes' where entitlements ?| array['airDots', 'airCallMinutes', 'airAwakeMinutes'];
update public.profiles set entitlements = entitlements - 'airDots' - 'airCallMinutes' - 'airAwakeMinutes' where entitlements ?| array['airDots', 'airCallMinutes', 'airAwakeMinutes'];
update public.organizations set entitlements = entitlements - 'airDots' - 'airCallMinutes' - 'airAwakeMinutes' where entitlements ?| array['airDots', 'airCallMinutes', 'airAwakeMinutes'];
