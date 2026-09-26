-- Prompt caching (providers/promptCache.ts): tracks the cached-read and cache-write portion of
-- each call's prompt tokens for accurate cost accounting and usage analytics. Both are already
-- included in the existing input_tokens total; these two are just the cache-related breakdown of
-- it (0 for a provider/call that reported no cache activity — nothing before this migration changes).
alter table public.token_ledger add column if not exists cached_tokens bigint not null default 0;
alter table public.token_ledger add column if not exists cache_write_tokens bigint not null default 0;
