create table if not exists public.razorpay_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  plan text not null check (plan in ('pro', 'business')),
  amount_paise int not null,
  currency text not null default 'INR',
  razorpay_order_id text not null unique,
  razorpay_payment_id text,
  status text not null default 'created' check (status in ('created', 'paid', 'failed', 'cancelled')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'razorpay',
  provider_event_id text,
  event_type text not null,
  payload jsonb not null,
  processed_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

alter table public.razorpay_orders enable row level security;
alter table public.billing_webhook_events enable row level security;

drop policy if exists "razorpay_orders: owner read" on public.razorpay_orders;
create policy "razorpay_orders: owner read" on public.razorpay_orders
  for select using (auth.uid() = user_id);

drop policy if exists "razorpay_orders: admin read" on public.razorpay_orders;
create policy "razorpay_orders: admin read" on public.razorpay_orders
  for select using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists "billing_webhook_events: admin read" on public.billing_webhook_events;
create policy "billing_webhook_events: admin read" on public.billing_webhook_events
  for select using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create index if not exists razorpay_orders_user_created_idx
  on public.razorpay_orders (user_id, created_at desc);
create index if not exists razorpay_orders_status_idx
  on public.razorpay_orders (status);
