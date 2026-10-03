# Delivery

Every job has a delivery list. The result is spoken, written into the app, or sent out. Several can be true at once.

## Channels

- `call` — speak it on the live call, or on a short callback if the call already ended
- `app` — the job and its link appear in Friday. Always on for artifacts
- `telegram`
- `whatsapp`
- `email`

## How the list is chosen

1. They name channels on the call. That list is the job's delivery.
2. If they name none, use Friday settings: the channels they turned on.
3. A channel still has to be enabled in admin. A user cannot opt into WhatsApp while the admin switch is off.
4. A callback is only used when `call` is on the list and the original call has ended. It spends minutes and respects quiet hours.

## Events the notifier sends

- `planned` — optional, for long jobs
- `running`
- `ready` — includes the link and a one-line summary
- `failed` — what broke, in one line, and that the work was kept

The app reads the job record directly. Telegram, WhatsApp, email, and the callback are fan-out from these events. They are not separate copies of the work.
