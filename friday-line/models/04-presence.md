# Presence

Presence is the set of live endpoints for one user. The phone session can see them and target them.

## Endpoints

- `phone` — this call
- `app` — web or mobile session online
- `cli` — FridayX on a computer, online
- `sandbox` — a sandbox Friday owns, whether or not a computer is online
- `telegram`, `whatsapp`, `email` — delivery endpoints, and later places a job can be given

## Fields on each endpoint

- `kind`
- `online` — true or false
- `label` — "office laptop", "sandbox", "Telegram"
- `last_seen_at`

## Rules

- "Do it on my machine" requires `cli` or `app` online. If nothing is online, Friday says so and offers the sandbox.
- "Do it in the sandbox" does not require another device. Friday opens or attaches one.
- Co-working means the call stays the discussion while the targeted endpoint does the work. Fast steps are spoken. Long steps follow the job duration rule.
- Delivery endpoints are not execution targets. Telegram does not run the sandbox. It receives the result.
