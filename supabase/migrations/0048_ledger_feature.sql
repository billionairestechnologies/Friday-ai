-- Which feature spent the credits (chat / build / research / teamup): powers the cost-based "what used
-- my usage" breakdown in Settings -> Usage. Older rows stay null and count as chat.
-- No policies: backend only (token_ledger already has RLS on).
alter table public.token_ledger add column if not exists feature text;
create index if not exists token_ledger_user_created_idx on public.token_ledger (user_id, created_at desc);
