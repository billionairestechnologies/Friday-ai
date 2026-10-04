# Runtime

There is one Friday runtime. The phone, the web app, the mobile apps, and the CLI are clients of it.

```
surface  ->  session  ->  runtime  ->  capability
```

A surface never calls a tool, a skill, a sandbox, or build mode on its own. It sends a user turn. The runtime decides what to run.

## Capabilities the phone may invoke

Same set as the app on that plan, unless admin narrows it.

- Tools and skills
- Deep research
- Build mode (presentations, documents, notes, mail, apps, and the other artifact types)
- Agent loops and always-on agents
- Sandbox
- Scheduler, automations, workflows
- A connected computer or CLI session, when presence says it is online

## What the voice vendor is allowed to do

Sarvam hears, speaks, and detects whose turn it is. It does not own the persona, the memory, the tool catalog, or the plan. The persona is in Friday's system prompt. Each user turn is a request to the runtime. The spoken line that comes back is the runtime's reply, rendered as audio.

## What a turn returns

Either:

- `speak` — text to say now, and the call stays open
- `speak_and_release` — text to say now, a job id, and the delivery targets, then the call may end

The runtime chooses which one from the duration policy on the job.
