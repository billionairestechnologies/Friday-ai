-- Expand usage metering for provider token/cost telemetry and Google connectors.
alter table public.usage_events
  drop constraint if exists usage_events_event_type_check;

alter table public.usage_events
  add constraint usage_events_event_type_check
  check (event_type in (
    'chat_message',
    'web_search',
    'voice_second',
    'sandbox_run',
    'attachment_upload',
    'token_usage'
  ));

alter table public.connector_accounts
  drop constraint if exists connector_accounts_provider_check;

alter table public.connector_accounts
  add constraint connector_accounts_provider_check
  check (provider in ('github', 'google'));

-- Invite acceptance tracking helper index.
create index if not exists organization_invites_token_hash_idx
  on public.organization_invites (token_hash);
