-- ─────────────────────────────────────────────────────────────────────────
-- Signup now collects a mobile number alongside name/email/password.
-- ─────────────────────────────────────────────────────────────────────────
alter table public.profiles add column phone text;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $function$
begin
  insert into public.profiles (id, full_name, phone)
  values (new.id, new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'phone');
  return new;
end;
$function$;
