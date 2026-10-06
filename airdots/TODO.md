# To-do

Air Dots is built on branch `feature/airdots-complete` (on top of `feature/airdots` / `v3`). It is **not merged**.
Migrations **0054–0056** must be applied before deploying it. Code paths are named in brackets.

## 1. The worker

- [x] An Air Dot job on the Friday runtime, tagged `origin: air` (`air/jobs.ts`, table `air_jobs`)
- [x] Starts in the background: `POST /api/air/jobs` answers at once; the loop holds a lease and survives a deploy (another instance resumes it)
- [x] The model reports its state with the `air_report` tool (working / done / blocked / needs_login / needs_approval) — no word matching
- [x] "rukho" or "stop" stops it from any door (web, WhatsApp, Telegram, the chat Stop button), on any instance
- [x] An empty Friday usage meter stops it (status `out_of_meter`)
- [x] Idle machines pause at 8 minutes; every keep-alive is charged to the daily awake cap (Pro 20 / Premium 45 min) (`air/awake.ts`)
- [x] Browser, shell, files and connectors go through one recorded gate (`air/gate.ts`, `air_actions`); Build Mode uses the same gate
- [x] Pay, buy, book, send, post and delete wait for a yes; the passphrase once it is set; one yes = one action

## 2. The website

- [x] `/air`: the dots design wired to the live runtime (`components/air-workspace.tsx`, `air_dots`)
- [x] Hidden unless the plan includes Air Dots; spends the same Friday meter, labelled `air` on the ledger
- [x] States: working, needs you (yes / sign in), done, stuck; badges in the list
- [x] The computer: the dot's live browser, click / type / keys / URL / drop a file; full screen on phones
- [x] Call now: the verified mobile when a trunk is configured, else the browser line; minutes left shown
- [x] Settings: name, instructions, mascot, animation, callback, quiet hours, Telegram link, passphrase, weekday schedule
- [x] Groups: one ask fans out to each member's job (groups themselves stay in the browser)

## 3. Outbound call

- [x] Pipecat bridge to Gemini Live (`airdots/pipecat/bot.py`), smoke-tested against Pipecat 1.12.0
- [x] Context-window compression on (bridge and `phone/live.ts`)
- [x] Exotel places the call (`EXOTEL_FLOW_URL` = Voicebot flow → the bridge); Twilio / Telnyx for other countries
- [x] Pro 15 / Premium 60 minutes from the plan's entitlements, added atomically in SQL; the call in progress counts
- [x] Short work stays on the line; long work becomes an Air Dot and the call ends
- [x] Persona prompt (`air/prompt.ts`): short, one question, one curious beat, then wait

## 4. Inbound call

- [x] Caller ID → account through an indexed `phone_last10` column; unknown numbers hear one line and the call ends
- [x] Spoken passphrase, hashed, asked before pay / send / delete; 5 wrong tries lock it for 15 minutes and tell the person
- [x] Set it by talking; changing it needs the old one ("change my passcode from … to …")
- [ ] One public number per trunk — buy and point it (see *To go live*)

## 5. After the job

- [x] The result is in the thread; sent to Telegram / WhatsApp / email when on
- [x] Friday calls back when the job is done (setting), inside minutes and quiet hours; urgent asks ring after 10 minutes unanswered
- [x] One memory per user: calls and jobs run through the same chat runtime (same memory tools and store)
- [x] Every call transcript saved (words, not audio) on `air_calls`; a new call starts with the last calls' summaries

## 6. Admin

- [x] Team Console → Phone & Air Dots: running jobs, waiting on people, calls, minutes, refused actions
- [x] Product updates: Air Dots / WhatsApp / Telegram platforms; publishing sends to linked Telegram chats (WhatsApp via an approved template only); one featured card on the Air Dots home

## To go live

1. Apply migrations 0054, 0055, 0056.
2. Backend env: `PHONE_GATEWAY_SECRET`, `PUBLIC_API_URL`, `GEMINI_API_KEY` (or a Gemini key in Models & keys).
3. Deploy `airdots/pipecat` as its own service behind `wss://` (env in its README).
4. India: Exotel number + Voicebot flow → `EXOTEL_SID`, `EXOTEL_TOKEN`, `EXOTEL_API_KEY`, `EXOTEL_CALLER_ID`, `EXOTEL_FLOW_URL`.
5. International: Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_CALLER_ID`, `PIPECAT_WS_URL`) or Telnyx.
6. Telegram: create the bot → `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`; set the webhook to
   `https://<api>/api/air/hooks/telegram/<TELEGRAM_WEBHOOK_SECRET>`.
7. WhatsApp Cloud API: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`; webhook
   `https://<api>/api/air/hooks/whatsapp/meta`. Optional `WHATSAPP_UPDATE_TEMPLATE` for product-update broadcasts.
8. Test on staging: a real Exotel call in, Call now out, a job that needs a yes, a sign-in on the screen, rukho on WhatsApp.

Not tested here (no keys or numbers in this environment): real carrier calls, real Gemini audio, Meta/Telegram webhooks
end to end, E2B browser screenshots. Kill switches: `FRIDAY_DISABLE_AIR_RESUME=1`, `FRIDAY_DISABLE_PLAN_EXPIRY=1`,
`FRIDAY_DISABLE_RENEWAL_REMINDERS=1`.

## Not in this build

- [ ] A new mobile app (the web page works on phones; native apps still use the old Air screens)
- [ ] A plugin per website
- [ ] A personal SIM as the public number
- [ ] Grok audio, until admin flips the voice provider
