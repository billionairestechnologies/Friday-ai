-- Credit meter: usage limits move from raw tokens to CREDITS (100,000 credits = US$1 of real model
-- cost — backend/src/services/quota/meter.ts). Every stored limit was sized in tokens at roughly
-- $1 per 1M, so credits = tokens / 10 keeps each plan, package and personal cap meaning what it
-- meant before. Column names keep their old "tokens" spelling (renaming would break older servers
-- during a rolling deploy); the unit is documented here and in tierConfig.ts.
--
-- Runs exactly once: the marker row stops a re-run from dividing twice. The live Redis counters
-- need no migration — the app reads new `quota:v2:*` keys, so the old token counts are ignored.
-- No policies: backend only.

create table if not exists public.meter_unit (
  id boolean primary key default true check (id),
  unit text not null,
  converted_at timestamptz not null default now()
);
alter table public.meter_unit enable row level security;

do $$
begin
  if exists (select 1 from public.meter_unit where unit = 'credits') then
    return;
  end if;

  update public.plan_catalog set
    weekly_tokens = case when weekly_tokens is null then null else greatest(1, weekly_tokens / 10) end,
    rolling_tokens = case when rolling_tokens is null then null else greatest(1, rolling_tokens / 10) end,
    monthly_tokens = case when monthly_tokens is null then null else greatest(1, monthly_tokens / 10) end,
    tokens_per_seat = case when tokens_per_seat is null then null else greatest(1, tokens_per_seat / 10) end;

  update public.profiles set custom_monthly_cap = custom_monthly_cap / 10 where custom_monthly_cap is not null and custom_monthly_cap > 0;
  update public.organizations set pooled_monthly_tokens = pooled_monthly_tokens / 10 where pooled_monthly_tokens is not null;
  update public.plan_packages set
    monthly_token_cap = case when monthly_token_cap is null then null else monthly_token_cap / 10 end,
    pooled_monthly_tokens = case when pooled_monthly_tokens is null then null else pooled_monthly_tokens / 10 end;
  update public.access_grants set
    monthly_token_cap = case when monthly_token_cap is null then null else monthly_token_cap / 10 end,
    pooled_monthly_tokens = case when pooled_monthly_tokens is null then null else pooled_monthly_tokens / 10 end;

  insert into public.meter_unit (id, unit) values (true, 'credits');
end $$;
