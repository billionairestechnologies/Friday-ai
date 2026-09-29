-- Build workspace: a conversation started from Friday's dedicated Build page ("like Claude Code")
-- is a build session — every message goes straight to the Build agent (no intent probe), and the
-- web app lists these in the Build workspace's own history instead of the main chat list.
-- 'chat' (default) keeps every existing conversation exactly as it was.
alter table public.conversations add column if not exists workspace text not null default 'chat';
