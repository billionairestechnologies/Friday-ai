-- Build Mode is moving out of normal chat into its own dedicated workspace: instead of the
-- sandbox agent auto-running inline inside any conversation, a conversation now has a `kind` —
-- 'chat' (the default, normal conversation) or 'build' (a promoted Build Mode session, always
-- driven by the sandbox agent). This lets build sessions be listed/filtered separately from
-- normal chat history while reusing conversations/messages/RLS/search/sharing as-is.
alter table public.conversations
  add column if not exists kind text not null default 'chat'
  check (kind in ('chat', 'build'));

-- A normal chat message that looks like a build/dev/design task no longer auto-builds; it carries
-- a light-weight suggestion instead ({ summary }) that renders as a "Go to Build Mode" card. This
-- is intentionally separate from the heavier `messages.build` column (steps/plan/preview), which
-- stays reserved for messages inside an actual 'build' conversation.
alter table public.messages add column if not exists build_suggestion jsonb;
