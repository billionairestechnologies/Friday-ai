-- 0063 Payment ledger: money actually received and given back (docs/product/V3_PROGRAM.md, phase 06).
--
-- Before: Finance "revenue" = Σ paid razorpay_orders by the ORDER's creation date; refund amounts were
-- never stored (a refund only shortened the term), fees and chargebacks didn't exist anywhere, and
-- cash collected and revenue earned were the same number.
--
-- payment_ledger is append-only, one row per money movement, keyed by the provider's own id (a
-- webhook delivered twice records once):
--   kind 'payment'    + amount received; fee_paise/tax_paise = Razorpay's fee on it
--   kind 'refund'     amount given back (positive number; subtracts)
--   kind 'chargeback' amount lost in a dispute (positive number; subtracts)
-- term_start/term_end on a payment = the period it pays for: revenue is RECOGNISED straight-line over
-- it (earned as the service is delivered); refunds/chargebacks reduce revenue when they happen.
--
-- Existing paid orders are backfilled as payments (occurred_at = when the order was marked paid; fee
-- unknown → null, shown as such). From now on the webhook writes every row (billingService).

create table if not exists public.payment_ledger (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'razorpay',
  provider_ref text not null,
  kind text not null check (kind in ('payment', 'refund', 'chargeback')),
  order_id text,
  user_id uuid references public.profiles (id) on delete set null,
  organization_id uuid references public.organizations (id) on delete set null,
  plan text,
  amount_paise bigint not null check (amount_paise >= 0),
  currency text not null default 'INR',
  fee_paise bigint,
  tax_paise bigint,
  occurred_at timestamptz not null,
  term_start timestamptz,
  term_end timestamptz,
  details jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  unique (provider, provider_ref),
  check (term_end is null or term_end > term_start)
);
-- No policies: backend only
alter table public.payment_ledger enable row level security;
create index if not exists payment_ledger_occurred_idx on public.payment_ledger (occurred_at);
create index if not exists payment_ledger_order_idx on public.payment_ledger (order_id);
-- One order is paid once: order.paid and payment.captured for the same payment can never both count.
create unique index if not exists payment_ledger_one_payment_per_order on public.payment_ledger (provider, order_id) where kind = 'payment' and order_id is not null;
create index if not exists payment_ledger_term_idx on public.payment_ledger (term_start, term_end) where kind = 'payment';

-- Backfill: every paid order becomes one payment row (idempotent — skipped if already there).
insert into public.payment_ledger (provider, provider_ref, kind, order_id, user_id, organization_id, plan, amount_paise, currency, occurred_at, term_start, term_end, details)
select
  'razorpay',
  coalesce(o.razorpay_payment_id, 'order:' || o.razorpay_order_id),
  'payment',
  o.razorpay_order_id,
  o.user_id,
  o.organization_id,
  o.plan,
  o.amount_paise,
  o.currency,
  o.updated_at,
  o.updated_at,
  o.updated_at + case
    when coalesce(o.metadata ->> 'billingCycle', 'monthly') = 'annual' then interval '12 months'
    when o.plan = 'package' and pkg.duration_days is not null then make_interval(days => pkg.duration_days)
    else interval '1 month' end,
  jsonb_build_object('backfilled', true)
from public.razorpay_orders o
left join public.plan_packages pkg on pkg.id = nullif(o.metadata ->> 'packageId', '')::uuid
where o.status = 'paid'
  and not exists (select 1 from public.payment_ledger l where l.provider = 'razorpay' and l.order_id = o.razorpay_order_id and l.kind = 'payment')
on conflict (provider, provider_ref) do nothing;

-- Revenue for [p_from, p_to): cash movements in the window, revenue earned in it (straight-line over
-- each payment's term) and what's still unearned at p_to (deferred revenue). All in paise.
create or replace function public.finance_revenue(p_from timestamptz, p_to timestamptz)
returns table (
  cash_in bigint, refunds bigint, chargebacks bigint, fees bigint, fees_unknown bigint, payments bigint, payers bigint,
  recognised bigint, deferred_at_end bigint
) language sql stable as $$
  with p as (
    select * from public.payment_ledger where kind = 'payment'
  ),
  earned as (
    select coalesce(sum(
      case when term_start is null or term_end is null then
        case when occurred_at >= p_from and occurred_at < p_to then amount_paise else 0 end
      else
        amount_paise * greatest(0, extract(epoch from (least(term_end, p_to) - greatest(term_start, p_from))))
          / extract(epoch from (term_end - term_start))
      end), 0)::bigint as v
    from p
  ),
  deferred as (
    select coalesce(sum(
      case when term_start is null or term_end is null or term_end <= p_to or occurred_at >= p_to then 0
      else amount_paise * extract(epoch from (term_end - greatest(term_start, p_to))) / extract(epoch from (term_end - term_start)) end), 0)::bigint as v
    from p
  ),
  w as (
    select * from public.payment_ledger where occurred_at >= p_from and occurred_at < p_to
  )
  select
    coalesce(sum(amount_paise) filter (where kind = 'payment'), 0)::bigint,
    coalesce(sum(amount_paise) filter (where kind = 'refund'), 0)::bigint,
    coalesce(sum(amount_paise) filter (where kind = 'chargeback'), 0)::bigint,
    coalesce(sum(coalesce(fee_paise, 0)) filter (where kind = 'payment'), 0)::bigint,
    count(*) filter (where kind = 'payment' and fee_paise is null)::bigint,
    count(*) filter (where kind = 'payment')::bigint,
    count(distinct coalesce(organization_id, user_id)) filter (where kind = 'payment')::bigint,
    (select v from earned) - coalesce(sum(amount_paise) filter (where kind in ('refund', 'chargeback')), 0)::bigint,
    (select v from deferred)
  from w
$$;

-- Reconciliation: paid orders with no payment row, and payment rows whose order isn't marked paid.
create or replace function public.finance_reconciliation()
returns table (issue text, order_id text, amount_paise bigint, at timestamptz)
language sql stable as $$
  select 'paid order without a payment record', o.razorpay_order_id, o.amount_paise::bigint, o.updated_at
  from public.razorpay_orders o
  where o.status = 'paid' and not exists (select 1 from public.payment_ledger l where l.order_id = o.razorpay_order_id and l.kind = 'payment')
  union all
  select 'payment recorded but the order is not marked paid', l.order_id, l.amount_paise, l.occurred_at
  from public.payment_ledger l
  left join public.razorpay_orders o on o.razorpay_order_id = l.order_id
  where l.kind = 'payment' and (o.id is null or o.status <> 'paid')
  union all
  select 'payment amount differs from the order', l.order_id, l.amount_paise - o.amount_paise, l.occurred_at
  from public.payment_ledger l
  join public.razorpay_orders o on o.razorpay_order_id = l.order_id
  where l.kind = 'payment' and l.amount_paise <> o.amount_paise
$$;

do $$
declare fn text;
begin
  foreach fn in array array['finance_revenue(timestamptz, timestamptz)', 'finance_reconciliation()'] loop
    execute format('revoke all on function public.%s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%s from authenticated', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', fn); end if;
  end loop;
end $$;
