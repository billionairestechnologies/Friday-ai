-- Profit controls: what a unit of usage really costs us, editable by the team without a deploy.
--  * blended_cost_per_m_inr — one flat rupee cost per 1M tokens for every model (our current supplier
--    deal: ₹250 per 10M tokens = ₹25 per 1M, all models combined). Used by the credit meter and the
--    ledger for any model that has no override of its own. 0 = off (use each model's list price).
--  * model_pricing.cost_override — a model that keeps its OWN cost rates even while the blended rate
--    is on (model-wise costing for the day the supplier prices models differently).
--  * target_cost_share_pct — the most of a plan's price we are willing to spend on usage at its caps
--    (the rest is margin, hosting and overhead); drives the suggested limits in Console → Plans.
--  * free_cost_budget_inr — what one Free user may cost us in a month.
--  * e2b_cost_per_hour_inr — sandbox (E2B) running cost; Build time is recorded as sandbox_second usage.
-- Hosting, domains and other fixed costs live in Expenses (recurring) and are allocated per paying
-- user in the plan economics. No policies: backend only.

alter table public.finance_settings
  add column if not exists blended_cost_per_m_inr numeric(10, 4) not null default 25 check (blended_cost_per_m_inr >= 0),
  add column if not exists target_cost_share_pct numeric(5, 2) not null default 40 check (target_cost_share_pct > 0 and target_cost_share_pct <= 100),
  add column if not exists free_cost_budget_inr numeric(10, 2) not null default 25 check (free_cost_budget_inr >= 0),
  add column if not exists e2b_cost_per_hour_inr numeric(10, 4) not null default 4.4 check (e2b_cost_per_hour_inr >= 0);

alter table public.model_pricing add column if not exists cost_override boolean not null default false;

alter table public.usage_events drop constraint if exists usage_events_event_type_check;
alter table public.usage_events add constraint usage_events_event_type_check
  check (event_type in ('chat_message', 'web_search', 'voice_second', 'sandbox_run', 'attachment_upload', 'token_usage', 'image_generation', 'sandbox_second'));
