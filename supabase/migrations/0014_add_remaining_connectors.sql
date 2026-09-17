-- All featured connectors can persist an encrypted credential per user.
alter table public.connector_accounts
  drop constraint if exists connector_accounts_provider_check;

alter table public.connector_accounts
  add constraint connector_accounts_provider_check
  check (provider in (
    'github',
    'google',
    'notion',
    'supabase',
    'railway',
    'finance',
    'box',
    'canva',
    'razorpay',
    'vercel'
  ));
