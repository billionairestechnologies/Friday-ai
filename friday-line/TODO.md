# To-do

Nothing here is started. This is the list to pick up after the research pass. Do the items in order. Each one should land on the shared runtime, not as a phone-only copy.

## 1. Runtime session

- [ ] One session type used by the phone, the web app, mobile, and the CLI
- [ ] The session can call tools, skills, build mode, deep research, and workflows that already exist
- [ ] Agent loops and always-on agents are addressed from the session. They run in the agent runtime, not inside the call
- [ ] A sandbox can be opened or attached from the session

## 2. Duration and delivery

- [ ] Before work starts, estimate short (about 5–10 seconds) or long
- [ ] Short work holds the call, speaks a "getting the details" line, then speaks the result
- [ ] Long work speaks what is starting and where it will land, then releases the call
- [ ] A tool that overruns the hold switches that job to async and says so
- [ ] Spoken delivery override: call, app, Telegram, WhatsApp, email
- [ ] Default delivery comes from Friday settings when they do not name a channel

## 3. Phone gateway

- [ ] Sarvam agent that only moves audio and turns. Friday's runtime decides
- [ ] Exotel number, India, KYC, connected in Sarvam
- [ ] Discussion turn-taking: user speaks, Friday answers, Friday waits
- [ ] Authorize on connect: registered, verified caller ID, Premium, minutes left
- [ ] Unknown numbers, wrong plan, and empty minutes get one sentence and the call ends
- [ ] Transcript stored on the session when the call ends
- [ ] Minutes deducted from the ledger for connected time, including an opted-in callback

## 4. Presence and co-working

- [ ] Registry of live endpoints for the user: this call, app, CLI or computer, sandbox
- [ ] "Do it on my machine" targets a connected Friday session
- [ ] "Do it in the sandbox" works when no other device is online
- [ ] Fast sandbox steps spoken on the call. Long steps delivered on the chosen channel

## 5. Notifier

- [ ] Job events: planned, approved, running, ready with link, failed
- [ ] Fan-out only to channels that are admin-enabled and user-opted-in
- [ ] Telegram delivery with a link
- [ ] Email delivery with a link
- [ ] App view of the same job, not a second pipeline
- [ ] WhatsApp adapter present and switched off until the free path exists
- [ ] Short callback when they opted in and have no chat channel

## 6. Admin and settings

- [ ] Team Console fields: enabled plans, ₹4 per minute, included minutes, hard cap, max held seconds, channel switches
- [ ] Default phone skill and tool set equals the app set for that plan
- [ ] Friday settings: delivery defaults, linked Telegram, WhatsApp, email, quiet hours, language, "call me when it is ready"
- [ ] Web, mobile, and CLI render the phone entry from the entitlements payload
- [ ] No plan name hardcoded in a client. Adding Pro is an admin edit

## 7. Safety on the line

- [ ] Spoken yes before create, send, delete, or pay
- [ ] Voice PIN when the action leaves the account
- [ ] "rukho" or "stop" pauses an auto-loop or always-on agent
- [ ] Audit log: call, tool, job, delivery, minute charge

## 8. Persona and memory

These sit on the session above. They do not replace it.

- [ ] Persona block in the phone system prompt: short spoken turns, one question, one curious beat, then wait
- [ ] Barge-in stops mid-sentence. No tool narration beyond one "getting it" line
- [ ] On end, store the transcript and a session summary on the verified account
- [ ] Next call injects a capped recap: last job, last delivery channel, open loops
- [ ] Vector store over session summaries only. No full history in the voice context
- [ ] Recap is context, not an opening speech. Curious beat may use one line of it
- [ ] Memory cannot grant send, delete, or pay

## Later, not this pass

- [ ] Give a job from Telegram or WhatsApp into the same session
- [ ] Turn WhatsApp on when it can be free
- [ ] Add Pro or Free by editing `phone.enabled_plan_ids`
- [ ] Self-hosted speech cascade only if the Sarvam hosted agent cannot call the runtime cleanly
