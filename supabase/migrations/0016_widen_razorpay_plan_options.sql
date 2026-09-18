alter table public.razorpay_orders
  drop constraint if exists razorpay_orders_plan_check;

alter table public.razorpay_orders
  add constraint razorpay_orders_plan_check
  check (plan in ('pro', 'premium', 'business', 'enterprise'));
