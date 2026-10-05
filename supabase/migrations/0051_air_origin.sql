-- Air Dots is a door, not a second account. A conversation started there is marked
-- origin = 'air' so its tokens are labelled on the same ledger. Chat and Build stay 'web'.
-- No policies: backend only.

alter table public.conversations
  add column if not exists origin text not null default 'web';

alter table public.conversations drop constraint if exists conversations_origin_check;
alter table public.conversations
  add constraint conversations_origin_check check (origin in ('web', 'air'));
