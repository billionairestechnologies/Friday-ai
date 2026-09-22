-- Enable Supabase Realtime (postgres_changes) on conversations and messages so
-- web and Android clients on the same account see live updates without polling.
-- RLS already scopes both tables to auth.uid() = user_id (directly on conversations,
-- via join on messages), so realtime payloads stay per-owner automatically.

alter table public.conversations replica identity full;
alter table public.messages replica identity full;

alter publication supabase_realtime add table public.conversations;
alter publication supabase_realtime add table public.messages;
