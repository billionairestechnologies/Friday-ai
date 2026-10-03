-- Plan cards no longer talk about tokens: usage is a plan allowance that resets every 5 hours / week / month
-- (the meter counts model cost, not raw tokens — see 0046). Only the exact old default lines are replaced, so any
-- wording the team wrote itself in Console -> Plans is left alone. Safe to run twice. No policies: backend only.
update public.plan_catalog set features = array_remove(array_replace(features, '250K tokens a week', 'Light daily usage, refreshed every 5 hours and weekly'), '50K tokens per 5-hour window') where id = 'free';
update public.plan_catalog set features = array_replace(features, '2.5M tokens a week (10M a month)', 'Generous usage every 5 hours, week and month') where id = 'pro';
update public.plan_catalog set features = array_replace(features, '6.25M tokens a week (25M a month)', 'About 2x Pro''s usage, the most for one person') where id = 'premium';
update public.plan_catalog set features = array_replace(features, 'Org-pooled tokens, no 5-hour lockout', 'Org-pooled monthly usage, no 5-hour lockout') where id = 'enterprise';
