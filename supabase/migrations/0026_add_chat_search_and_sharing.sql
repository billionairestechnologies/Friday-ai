-- Full-text search across every chat a user has (not just titles / chats loaded in the browser), and
-- read-only public share links for a conversation.
-- 'simple' config: no language-specific stemming, so it works the same for English, Hindi and
-- mixed-script messages. Only the first 100k chars of a message are indexed (tsvector caps at 1MB).
alter table public.messages
  add column if not exists search_tsv tsvector
  generated always as (to_tsvector('simple', left(coalesce(content, ''), 100000))) stored;
create index if not exists messages_search_tsv_idx on public.messages using gin (search_tsv);

-- A random, unguessable token; null = not shared. Revoking clears it (old links stop working).
alter table public.conversations add column if not exists share_token text unique;
alter table public.conversations add column if not exists shared_at timestamptz;
