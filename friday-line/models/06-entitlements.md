# Entitlements and minutes

Access is resolved the same way as the rest of Friday: plan defaults, then the catalog, then the organization, then a personal package. The phone adds one feature to that resolver. It does not invent a parallel billing system.

## Admin record

- `phone.enabled_plan_ids` — `premium` only at launch
- `phone.inr_per_minute` — `4`
- `phone.included_minutes`
- `phone.hard_cap_minutes`
- `phone.max_held_seconds`
- `notifier.telegram_enabled` — on
- `notifier.whatsapp_enabled` — off until the path is free
- `notifier.email_enabled` — on
- Phone capability set — defaults to the app's set for that plan

Editing `enabled_plan_ids` to include `pro` is enough for the next authorize call and the next app fetch to allow it. Clients must not hardcode the plan name.

## User settings record

- `notify_call`
- `notify_app` — always available
- `notify_telegram`, `telegram_chat_id`
- `notify_whatsapp`, `whatsapp_id` — inert while admin has WhatsApp off
- `notify_email`, `email`
- `quiet_hours`
- `language`

## Minute ledger

- Charged for connected seconds, rounded in a way the admin record defines
- Includes held short turns and opted-in callbacks
- Does not include time a long job runs after the call has ended
- Authorize fails closed when remaining minutes are zero
- The ₹4 figure is the planning rate so a plan's price can cover Exotel, Sarvam speech, and Friday's own model work. The number the product enforces is the one in admin

## Gate order

1. Is there a registered user for this caller ID?
2. Is their resolved plan in `enabled_plan_ids`?
3. Are minutes remaining above zero?
4. Only then create a session.
