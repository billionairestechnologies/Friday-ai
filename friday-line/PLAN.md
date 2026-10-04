# Plan

Status: saved, not started. Research first. Implementation after that.

## What this is

Someone who will not live in an app can still run Friday. They call. Friday is the person on the line. They can ask for anything the runtime can already do, and for the things still being built on the same runtime: tool calls, skills, auto-looping agents, always-on agents, sandboxes, build mode, deep research, documents, mail, notes, schedules, automations, and workflows.

The phone is not a smaller Friday. If a computer, the CLI, or a sandbox is connected, the call can drive that too. They talk. Friday operates the connected system.

## Upgrades

Four upgrades sit on this session. They do not replace the runtime, the delivery channels, or the hold-or-release rule. The spec is [UPGRADES.md](UPGRADES.md).

- **Persona.** Style lives in Friday's system prompt. Short spoken turns, one curious beat, then she waits.
- **Memory.** Transcript and a capped recap are stored on the verified account. The next call sees last job, last channel, and open loops. Memory does not grant a tool.
- **Cost guard.** The hold-or-release rule stands. She stays short because the line is metered. The gateway enforces the same entitlements as the app.
- **Human in the loop.** Spoken yes, voice PIN when it leaves the account, and "rukho" or "stop" pauses a loop. Unknown numbers never reach the agent.

## How the call feels

A discussion. The user asks. Friday answers. She stops and waits. The full spoken style is the persona upgrade.

- One turn each. Friday does not keep talking, and she does not fill silence.
- She asks a clarifying question only when the job is actually ambiguous, then she waits.
- She does not run an interview or a script.
- Barge-in exists so the user can cut in. She does not talk over them.
- Sarvam handles hearing, voice, and turn-taking on the Indian phone line. The decisions come from Friday's runtime.

## Hold the line, or leave it

A connected minute costs about ₹4. The capability is the same either way. The clock decides whether the line stays up.

- **Short work, about 5–10 seconds.** Stay on the call. Friday says she is getting the details, runs the tool or skill, and speaks the result. A lookup, a status check, a short note, a mail draft they want heard, a small edit.
- **Long work.** Deep research, a build, a sandbox run, an agent loop, a workflow that has to execute. Friday says what she is starting and where the result will land. The call ends. The job keeps running.
- If they say "stay with me" on a long job, that is an explicit choice and it spends the minute cap. The default is to release the line.
- If a held tool overruns the short window, Friday says she is continuing it off the line and that job becomes async.

## Where the result goes

They say it on the call, or it follows Friday settings. One job can be spoken and also copied out.

- Spoken on the call
- In the Friday app
- Telegram
- WhatsApp
- Email

"Put it in the app." "Send it on Telegram." "WhatsApp and email." The spoken choice overrides the default for that job. Settings are the default next time: which channels are on, quiet hours, language, and whether a finished long job also gets a short callback.

WhatsApp is a delivery channel in the design. Telegram can ship first. The admin flag turns WhatsApp on when that path is free. Email ships with the others. The app always has the artifact, because the app is a view of the same job.

## What the phone can run

Nothing in this list is phone-only. The phone calls the same runtime as the app.

- **Tools and skills.** Whatever is registered for that plan. The voice layer does not keep a second, smaller catalog.
- **Deep research and other slow data work.** Started on the call, finished off the call, delivered where they asked.
- **Build mode.** Apps, presentations, documents, notes, mail, and the other artifact types. A spoken yes before something is created or sent. Then it runs off the line.
- **Auto-looping and always-on agents.** Create, pause, change, and ask status from the phone. The loop runs in the agent runtime. The call is the remote control, not the place the loop lives.
- **Sandbox, co-working.** Friday can open or attach a sandbox and operate it. Fast steps are spoken. Long steps are reported on the chosen channel. If their computer or CLI session is online, the phone can target that system.
- **Scheduling, automations, workflows.** "Every morning, research this and email it" becomes a workflow record. The scheduler runs it later. The phone creates and edits it the same way the app does.

## Who can call

Checked at the start of every call, before Friday speaks as herself.

- Registered account. The caller ID matches a verified phone on that account.
- The plan is in the admin allow-list. Right now that list is Premium only. Free and Pro are off.
- Remaining phone minutes for the period are above zero.
- Otherwise one sentence and the call ends: not linked, not on this plan, or minutes used up.

Unknown numbers never reach the agent. Sending, deleting, and paying need a spoken yes, plus a voice PIN when the action leaves the account.

## One config

The Team Console is the only place that turns the phone on, prices it, and moves it between plans. Web, mobile, CLI, the phone gateway, and the notifier do not each store "Premium includes the phone."

Admin fields, read by every surface:

- `phone.enabled_plan_ids` — starts as Premium. Adding Pro later is an admin edit. The next call and the next app fetch allow it.
- `phone.inr_per_minute` — 4, so burn is visible and the cap can be resized.
- `phone.included_minutes` and `phone.hard_cap_minutes`
- `phone.max_held_seconds` — a short hold cannot drift into a silent call
- Master switches for Telegram, WhatsApp, and email
- Which skills, tools, sandboxes, and agent features the phone may invoke. Default is the same set as the app on that plan.

Friday settings, one record, edited from any surface:

- Default delivery channels
- Linked Telegram, WhatsApp, and email
- Callback when a long job finishes
- Quiet hours and language

Clients show or hide Call from the entitlements payload. The gateway enforces the same payload, so an old app cannot grant a free user a call by skipping a button.

## Voice path

Sarvam for speech. Exotel for the Indian number (`api.in.exotel.com`, KYC, Exophone saved under Sarvam Deploy, Phone Numbers). The Sarvam agent stays thin: audio in, each user turn to Friday, audio back.

- Each turn goes to the runtime with the call session id.
- The runtime returns a spoken reply, or a spoken acknowledgement plus a job id and a delivery target.
- `on_end` stores the transcript on the session, keyed to the verified account, and deducts minutes. The next call gets a capped recap, not the full history.
- Gateway hosted in India. Sarvam's tool-call egress `4.213.167.70` is allowlisted. The service token stays on the server.

Latency to hold while testing the short path: a spoken acknowledgement under a second, a simple answer inside the 5–10 second hold. A US-east voice hop adds 200–300 ms on its own.

Rough carrier and speech cost, before Friday's own model bill: Exotel about ₹0.40–₹1.50 per minute, Sarvam speech-to-text ₹30 per hour, Bulbul text-to-speech ₹30 per 10,000 characters. The product meters the call at about ₹4 per minute so the plan price covers the stack. Sarvam's older "₹1 per minute" headline is not the current API price card.

## What this pass does not do

- Rename the voice on the call. She is Friday.
- Open the number to Free or Pro. The allow-list can be edited later.
- Leave the line open while a presentation, a research run, or an app is generated, unless they explicitly stay and spend minutes.
- Turn on a paid WhatsApp API. The channel exists in the model and stays off until it is free.
- Hardcode plan checks inside web, iOS, Android, or the CLI.
- Put Friday's prompt, memory, or tool catalog inside Sarvam. That would make a second brain.

## Build order

The architecture is the whole runtime. The order is only so the first call is already Friday.

1. A session the phone, the app, and the CLI share: tools, skills, agents, sandbox, build, workflows.
2. Duration policy and delivery targets on that session.
3. Phone gateway on Sarvam and Exotel, Premium gate, and the minute ledger.
4. Presence, so a call can attach a sandbox and a connected system.
5. Delivery workers for the app, Telegram, email, and WhatsApp behind the admin flag.
6. Settings and Team Console screens that only edit the shared config.

## Voice vendor

Sarvam is the voice layer because the call has to sound right in Indian languages on an 8 kHz phone line, with barge-in, and with Exotel as a first-party connection. Bulbul v3 is the telephony voice. A self-hosted speech-to-text, model, speech cascade with the same Sarvam speech models measures about 700 ms–1.2 s before any tool runs. That cascade is the escape hatch if the hosted agent cannot hand each turn to Friday cleanly. It is not the first build.
