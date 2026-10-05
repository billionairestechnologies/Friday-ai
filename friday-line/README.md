# Air Dots

Friday is the product. **Air Dots** is the always-on computer inside it, and the call that drives it.

The person they talk to is Friday. The website button says **Call now**. That surface is **On Air**. This folder used to be called Friday line. The name of the feature is Air Dots. The folder path stays `friday-line` so the repo link does not move.

Nothing here is wired into the site yet.

## Read this order

1. [PLAN.md](PLAN.md) — the system, the call, the sandbox, the minutes, the cost
2. [TODO.md](TODO.md) — build order
3. [UPGRADES.md](UPGRADES.md) — how she speaks, what she remembers, when she stops
4. [models/](models/README.md) — session, job, sandbox presence, delivery, entitlements
5. [flows/](flows/README.md) — discussion, hold or release, making a job
6. [diagrams/](diagrams/README.md) — the earlier drawings, still useful under the new name

## Locked decisions

- One website. One phone number. No new app.
- Agent work, the sandbox, and Build Mode spend the Friday usage meter.
- Call minutes are separate: Pro 15 a month, Premium 60 a month, hidden on every other plan.
- One E2B sandbox per user, the one Friday already has. It pauses when idle.
- The loop runs until the task is done, they say stop, or the meter is empty.
- Gemini Live is the voice. The worker model is chosen in admin and starts as the Build Mode model.
- Pipecat carries the call. Exotel is the India number. Telnyx or Twilio is the international number.
- A registered caller ID is the login. A spoken passphrase is the check before money, a send, or a delete.
