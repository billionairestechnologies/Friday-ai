# Job

A job is one piece of work started from a session. Short jobs finish inside the call. Long jobs outlive the call.

## Fields

- `job_id`
- `session_id`
- `user_id`
- `kind` — tool, skill, research, build, sandbox, agent, workflow, chat
- `request` — what they asked, in their words
- `plan` — one or two sentences Friday will repeat before anything is created or sent
- `duration` — `short` or `long`
- `state` — `draft`, `waiting_yes`, `running`, `paused`, `ready`, `failed`, `cancelled`
- `needs_yes` — true when the job creates, sends, deletes, or pays
- `delivery` — see [Delivery](05-delivery.md)
- `result_link` — set when there is an artifact
- `spoken_summary` — what was said, or what a callback should say

## Duration rule

- Expected work about 5–10 seconds: `short`. Hold the call.
- Expected work longer than that, or unbounded: `long`. Release the call after the acknowledgement.
- A short job that overruns `phone.max_held_seconds` flips to `long` and Friday says she is continuing it off the line.

## Approval rule

Chat and a short lookup do not wait for a separate yes. They run and the result is spoken.

A job that creates an artifact, sends a message, deletes, pays, starts a loop, or changes a workflow waits in `waiting_yes` until they say yes. No is `cancelled`. Silence until the call ends leaves it `draft`.

## State machine

```
draft -> waiting_yes -> running -> ready
                     -> cancelled
draft -> running -> ready
running -> failed
running -> paused
running (overran hold) stays running, duration becomes long
```

`paused` is what "rukho" or "stop" does to an auto-loop or always-on agent. The loop stays in the agent runtime. The call does not host it.

Always-on agents and workflows are jobs that remain `running` after the call. Later turns on a new call can pause, edit, or ask status. Those status reads are short jobs.
