# Friday line

Friday on a phone call. The name on the call stays **Friday**. This folder is the architecture for that surface: the plan, the working models, the flows, and the diagrams. Nothing here is wired into the app yet. Build starts after the research pass.

A call is a full Friday session. Tools, skills, agent loops, always-on agents, the sandbox, build mode, schedules, and workflows are the same runtime the web app, mobile apps, and CLI already use. The phone is another way in.

## Read this order

1. [PLAN.md](PLAN.md) — what it is, what a call does, and the build order
2. [TODO.md](TODO.md) — the work list, not started
3. [models/](models/README.md) — the records the runtime keeps
4. [flows/](flows/README.md) — discussion, hold-or-release, making a job, delivery, co-working
5. [diagrams/](diagrams/README.md) — Mermaid sources, plus SVG and PNG

## Where this sits

```
friday-line/     this folder — phone session architecture
backend/         Friday API
frontend/        web app and Team Console
android/  ios/   mobile apps
cli/             Friday X
docs/            platform docs already in the repo
```

Web, mobile, CLI, Telegram, WhatsApp, and email do not each grow their own Friday. They call the runtime described here. Admin changes a plan or a minute cap once. Every surface reads that.

## Locked decisions

- The person on the other end of the call is Friday. No second product name.
- Premium only, until the Team Console allow-list says otherwise.
- About ₹4 per connected minute. The cap lives in admin.
- Short work (about 5–10 seconds) stays on the line and is spoken back.
- Long work (deep research, build, sandbox, loops) starts on the call and finishes off it.
- The person chooses delivery: spoken, the app, Telegram, WhatsApp, or email.
- The call is a discussion. They speak, Friday answers, Friday waits.
