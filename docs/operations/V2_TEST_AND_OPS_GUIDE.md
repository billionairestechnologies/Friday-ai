# Friday v2 — Test & Operations Guide

**For:** the Testing (QA) team and the System Management (Ops) team.
**Status:** v2 is live in production at https://friday.billionairestechnologies.com (since 2026-09-30).
**How to use this document:** copy it into your tracker (Docs / Notion / Sheets). Every test table has empty **Result / Notes** columns — fill them in and send the filled copy back to the product owner. Sections 3A–7 are for testers (3A = every page URL), sections 8–11 for system management.

| | |
|---|---|
| Document version | 1.0 |
| Date | 2026-09-30 |
| Build under test | `main` = v2 (branch `v1` = previous version, kept as a backup) |
| Prepared by | Product owner / Claude |
| QA lead | ______________________ |
| Ops lead | ______________________ |
| Review round | ☐ 1  ☐ 2  ☐ 3 |
| Overall sign-off | ☐ Approved  ☐ Approved with issues  ☐ Rejected |

> **Never paste passwords, API keys or tokens into this document or into tickets.** Ask the owner for test accounts.

---

## 1. What is new in v2 (summary)

Friday v1 was a multi-model chat assistant. v2 turns it into an **agent platform** on **its own infrastructure**:

| Area | v1 | v2 |
|---|---|---|
| Hosting | Railway (app) + supabase.com (database) | **One AWS server (Mumbai)** running the app, Redis, HTTPS proxy and a **self-hosted Supabase** |
| Build Mode | Started automatically inside chat | **Separate Build workspace** (sidebar → Build), Claude Code-style UI |
| Build flow | Plan drawn and executed immediately | **Plan → you approve (or request changes) → build** |
| Permissions | Everything ran automatically | **3 permission modes** + approval prompts (Allow / Deny / Allow all) |
| Safety net | none | **Checkpoints**: "Restore to before this message" |
| Long builds | Lost if you closed the tab | **Live resume**: reopen on any device, replay + follow; push when done |
| Project secrets | none | **Secrets vault** (encrypted, hidden from the AI and the terminal) |
| Shipping | zip / pull request | + **one-click Vercel deploy**, **GitHub repo + branch picker** (create repo/branch) |
| Starting a project | blank prompt | **Templates** (Next.js, React+Vite, Python API, Landing page) |
| Code review | none | **Diff tab** (files changed with +/− lines) |
| Chat | could start builds | Chat answers normally and offers **"Open in Build"** |
| Tools / skills | — | Agent tools (web, code, connected apps, MCP), **Skills** (expert playbooks), Deep Research, Automations, Memory, Library |
| Back office | basic admin | **Team Console** with roles, CRM, support, campaigns, plans & offers, status & crashes, audit log |
| Backups | none | **Nightly backup to S3** (30-day retention) |
| Apps | Android + iOS on the old backend | Android + iOS rebuilt against v2 (live sync now uses the new server) |

---

## 2. Environments, access and accounts

### 2.1 Where things are

| Item | Value |
|---|---|
| Web app | https://friday.billionairestechnologies.com |
| Health (public) | `GET /api/health` (also `/api/health/ready`, `/api/health/live`) |
| Public status page | `/status` |
| Back office (Team Console) | `/admin` (hidden, not linked from the app) |
| Source | GitHub `billionairestechnologies/Friday-ai` — `main` = v2, `v1` = old version, `v2` = working branch (same as main) |
| Server | AWS account 095713295449, region **ap-south-1 (Mumbai)**, EC2 `i-0414cc992c753285f`, Elastic IP `13.200.53.44` |
| DNS | Squarespace Domains, record `friday` → A `13.200.53.44` |
| Backups | S3 bucket `friday-v2-backups-095713295449` |

### 2.2 Who gets what

| Team | Needs | Get it from |
|---|---|---|
| Testers | Test user accounts (Free, Pro, Premium, Enterprise-org member); one **Owner/Admin** login for the back office; one **staff** login per role to test permissions | Product owner |
| Ops | AWS access (Systems Manager session to the server — **no SSH**), CodeBuild/ECR/S3/Secrets Manager read, GitHub repo access | Product owner (AWS IAM) |

### 2.3 Important facts for testing right now

1. **Everybody signs in again once** — the session keys changed with the new database. Email + password are unchanged.
2. The **"Updated Terms & Privacy Policy → I Agree"** screen appears once per account after the move.
3. **GitHub must be connected again** (Plugins → GitHub). The old connection stayed on the retired system.
4. **DNS cache:** until about 19:00 IST on 2026-09-30, some networks still resolve the old address and show Railway's *"Application failed to respond"* page. That is not a v2 bug. Test on mobile data or another network if you see it.
5. **Email codes (OTP)** for brand-new users are limited by the email provider's sandbox until a sending domain is verified (known open item, §11).
6. **Usage limits are real.** Each plan has a rolling 5-hour window; hitting it shows a clear message (§9).

---

## 3. Architecture at a glance

```
Browser / Android / iOS
        │  HTTPS (Let's Encrypt, auto-renewing)
        ▼
   Caddy (proxy) ──┬── /auth/v1  /rest/v1  /storage/v1  /realtime/v1 ──► self-hosted Supabase gateway
                   └── everything else ─────────────────────────────────► Friday app (Node/Express + React)
                                                                              │
   Friday app ──► Redis (rate limits, quota counters, locks)                  ├──► AI providers (OpenAI, Anthropic, Gemini, OpenRouter, ScaleMax, Sarvam, Ollama, ElevenLabs)
                                                                              ├──► E2B cloud sandboxes (Build Mode)
                                                                              ├──► GitHub / Vercel / Google / Notion … (user-connected)
                                                                              └──► Resend (email), Razorpay (payments)
   Self-hosted Supabase = Postgres + Auth (GoTrue) + REST + Storage + Realtime (+ Studio/Meta/Edge, private)
   Nightly: database dump + stored files ──► S3
```

- **One server** (2 vCPU, 8 GB). Normal load is very low (load average < 1).
- The **database and file storage are on the same server** — backups (§10.6) are therefore essential.
- Supabase Studio and the Postgres ports are **not public**.

---

## 3A. Page and URL directory (test every one)

Base: **https://friday.billionairestechnologies.com**. The site is a single-page app, so every URL below returns HTTP 200 from the server; what you *see* depends on whether you are signed in. "Logged out" / "Logged in" say what to expect. An unknown URL must show a **"Page not found"** page (404).

### 3A.1 Public pages (no login needed)

| ID | URL | Page title (browser tab) | What you should see | Result | Notes |
|---|---|---|---|---|---|
| U-01 | `/overview` | Overview — Friday AI | Product overview page, top nav (Overview · Models · Build · Research · Connectors · Automations · Plans), "Try Friday" button | | |
| U-02 | `/models` | Models — GPT, Claude, Gemini and more in Friday | Models explainer page | | |
| U-03 | `/research` | Deep Research — Friday AI | Deep Research explainer | | |
| U-04 | `/connectors` | Connectors — Friday AI | Connected-apps explainer | | |
| U-05 | `/plans` | Plans & Pricing — Friday AI | Four plans with prices (Free ₹0, Pro ₹999, Premium ₹1,999, Enterprise ₹2,499/seat); buy buttons | | |
| U-06 | `/build` (logged out) | Friday Build — describe an app, get a running app | Public Build product page: "Describe it. Friday builds it.", Start building / See plans | | |
| U-07 | `/automations` (logged out) | Automations — Friday AI | Public Automations explainer | | |
| U-08 | `/privacy` | Privacy Policy — Friday AI | Full policy, current version date | | |
| U-09 | `/terms` | Terms of Service — Friday AI | Full terms | | |
| U-10 | `/status` | System Status — Friday AI | Component status, incidents, 90-day history (works even if the app is degraded) | | |
| U-11 | `/share/<token>` | Friday | A shared chat, read-only (get a token by sharing a chat; an invalid/revoked token shows a clear "not found/disabled" message) | | |
| U-12 | `/some-unknown-page` | Page not found — Friday | "Page not found" + "Back to chat" link (HTTP 404) | | |
| U-13 | `/sitemap.xml` | — | XML list of the public pages | | |
| U-14 | `/robots.txt` | — | Robots rules + sitemap link | | |

### 3A.2 App pages (login required)

| ID | URL | Logged out | Logged in — what you should see | Result | Notes |
|---|---|---|---|---|---|
| U-20 | `/` | Landing with sign-in/sign-up | New-chat screen: greeting, composer (attach, search, settings, model picker, voice, mic), 4 suggestion cards, sidebar (Chat · Build · Library · Automations, Projects, Chats, Plugins, profile) | | |
| U-21 | `/c/<conversationId>` | sign-in | That chat, with history; realtime updates | | |
| U-22 | `/build` | Public Build page (U-06) | **Build home**: "Welcome back", templates, Sessions, Pull requests, repo chip, composer with permission + effort pickers; Build-style sidebar (Chat⇄Build switch, Recents with status dots) | | |
| U-23 | `/build/<conversationId>` | sign-in | A Build session: messages, plan card / steps, side panel (Preview · Files · Diff · Terminal · Secrets · Deploy) | | |
| U-24 | `/library` | sign-in | Saved code, pages and images; search, open, delete | | |
| U-25 | `/automations` | Public page (U-07) | Your automations list; create/edit/pause/delete | | |
| U-26 | `/projects` | sign-in | Projects list; create | | |
| U-27 | `/projects/<projectId>` | sign-in | Project detail: instructions, its chats, files | | |
| U-28 | `/plans` | public | Same page as U-05, with your current plan highlighted | | |
| U-29 | `/upgrade` | sign-in | Plans / checkout page (same component as `/plans`) | | |
| U-30 | `/team` | sign-in | **Enterprise organisation members only**: seats, invites, usage; other users get no access / redirect | | |
| U-31 | `/mobile-auth-bridge` | — | Internal hand-off page used when signing in from the mobile apps; not meant to be opened by hand | | |
| U-32 | `/?dialog=plugins` | sign-in | App opens with the **Plugins** drawer open (used as the return address after connecting an app) | | |
| U-33 | `/?support=contact` | sign-in | App opens with **Help & support** (contact form) | | |
| U-34 | Terms "I Agree" gate | — | Shown on any page for accounts that haven't accepted the current version; dim background, not dismissable; `/privacy`, `/terms`, `/status` stay reachable | | |

### 3A.3 Back office (Team Console) — staff only

Login page: **`/admin`** (password, then emailed code). After login each section has its own URL; a section you lack permission for must **not** appear and opening its URL directly must be refused.

| ID | URL | Section | Needs permission | Result | Notes |
|---|---|---|---|---|---|
| U-40 | `/admin` | Login / console home (opens Overview) | staff or owner | | |
| U-41 | `/admin/overview` | Overview (KPIs) | overview.view | | |
| U-42 | `/admin/support` | Support tickets | support.view | | |
| U-43 | `/admin/crm` | CRM leads & clients | crm.view | | |
| U-44 | `/admin/tasks` | Team tasks | tasks.view | | |
| U-45 | `/admin/updates` | Product updates | updates.view | | |
| U-46 | `/admin/marketing` | Email campaigns | marketing.view | | |
| U-47 | `/admin/plans` | Plans & offers | plans.view | | |
| U-48 | `/admin/users` | Users | users.view | | |
| U-49 | `/admin/team` | Team & roles | team.manage | | |
| U-50 | `/admin/mail` | Team mail addresses | mail.manage | | |
| U-51 | `/admin/status` | Status & crashes | status.view | | |
| U-52 | `/admin/models` | Models & keys | providers.view | | |
| U-53 | `/admin/billing` | Billing & usage | users.view | | |
| U-54 | `/admin/audit` | Audit log | audit.view | | |

### 3A.4 Technical URLs (Ops / API testers)

| ID | URL | Expected | Result | Notes |
|---|---|---|---|---|
| U-60 | `GET /api/health` | `{"status":"ready","service":"friday-ai-backend","dependencies":{"database":"ok","redis":"ok"}}` | | |
| U-61 | `GET /api/health/live` | 200 (process is up) | | |
| U-62 | `GET /api/health/ready` | 200 when database and Redis are reachable | | |
| U-63 | `GET /api/models` | 200, JSON list of models for the public picker | | |
| U-64 | `GET /api/status` | 200, public status data | | |
| U-65 | `GET /api/auth/policy` | 200, current policy version | | |
| U-66 | `GET /api/app/version` | 200, latest app version info | | |
| U-67 | `GET /api/auth/me` without a token | 401 "Missing bearer token" | | |
| U-68 | `GET /api/console/me` as a normal user | 403 | | |
| U-69 | `GET /auth/v1/health` with header `apikey: <anon key>` | 200 (self-hosted sign-in service) | | |
| U-70 | `GET /storage/v1/status` | 200 | | |
| U-71 | WebSocket `wss://friday.billionairestechnologies.com/realtime/v1/websocket?apikey=<anon key>&vsn=2.0.0` | Connects (live sync) | | |
| U-72 | `http://friday.billionairestechnologies.com/` | Redirects (308) to `https://…` | | |
| U-73 | Certificate on the domain | Valid (Let's Encrypt), not expired, matches the name | | |
| U-74 | Supabase Studio / Postgres from the internet | **Not reachable** (must time out or be refused) | | |

---

## 4. Feature guide and test cases — everyday app

Legend: **Result** = ✅ pass / ❌ fail / ⚠️ pass with issue / ⏭ not tested. **Notes** = what you saw, link to screenshot/ticket.

### 4.1 Accounts and sign-in (`/`, `/api/auth/*`)

Routes: `POST /api/auth/signup | login | verify-otp | resend-otp | refresh | password-reset | logout | accept-policy`, `GET /api/auth/me | policy | export`, `PATCH /api/auth/profile`, `DELETE /api/auth/account`, Google/GitHub login via `/api/auth/google/*` and `/api/auth/github/*`.

| ID | Test | Expected | Result | Notes |
|---|---|---|---|---|
| A-01 | Sign in with email + password | Email code (OTP) step, then you are in | | |
| A-02 | Wrong password | Clear "Invalid email or password" | | |
| A-03 | "Sign in with Google" | Returns to the app signed in (same account if same email) | | |
| A-04 | "Sign in with GitHub" | Returns to the app signed in | | |
| A-05 | Sign-up with new email | OTP email arrives* | | |
| A-06 | Password reset | Email arrives*, link works | | |
| A-07 | First login after the move | "I Agree" terms screen, then app | | |
| A-08 | Log out, then log in on a second device | Both work; chats sync | | |
| A-09 | Profile edit (phone, birthday) | Saved, survives reload | | |
| A-10 | Export my data (`/api/auth/export`) | JSON with my data | | |
| A-11 | Delete account (use a throw-away account!) | Account and data removed, cannot log in | | |

\* May fail for new addresses until email sending is verified (§11).

### 4.2 Chat (`/`, `/c/:conversationId`)

Routes: `/api/chat/conversations` (list/create/patch/delete), `/messages`, `/messages/stream` (SSE), `/stop`, `/search`, `/api/share/*`, `/api/models`.

| ID | Test | Expected | Result | Notes |
|---|---|---|---|---|
| C-01 | New chat, send "say hi in five words" on **Auto** | Reply streams within a few seconds | | |
| C-02 | Pick a specific model from the picker | Reply comes from that model (label shows it) | | |
| C-03 | Stop button during a long reply | Stops within ~2 s; partial text kept | | |
| C-04 | Send a second message while the first is generating | Queued, sent after the first finishes | | |
| C-05 | Reload the page mid-reply | Reply still completes and appears (server keeps generating) | | |
| C-06 | Attach an image and ask about it | Answer refers to the image | | |
| C-07 | Attach a PDF / DOCX / XLSX | Content is used in the answer | | |
| C-08 | Search toggle on, ask a news question | Answer with sources | | |
| C-09 | Think toggle | Visible reasoning step; slower but deeper | | |
| C-10 | Canvas (ask for an HTML page) | Page previews in the side panel | | |
| C-11 | Deep Research (from the **+** menu) | Long multi-source report; counts against daily limit | | |
| C-12 | Team Up model | Several models answer; merged result | | |
| C-13 | Chat title auto-generated; rename/delete a chat | Works; delete syncs to other devices | | |
| C-14 | Sidebar full-text search | Finds text inside old messages | | |
| C-15 | Share a chat (public link), open in a private window | Read-only page loads; "turn off sharing" revokes it | | |
| C-16 | Ask for an app in normal chat ("build me a todo app") | Normal answer **plus an "Open in Build" card** (chat never starts a build) | | |
| C-17 | Live sync: send on device A, watch device B | Appears on B within seconds | | |
| C-18 | Hit the 5-hour usage limit (use a Free test user) | Message stays on screen **with the reason**, not silently dropped | | |
| C-19 | Image generation ("draw a red fox") | Image returned | | |

Model picker note: **slow "thinking" models can take ~50 s** for long answers — that is the model, not the server. Use **Auto** for speed.

### 4.3 Library, Memory, Skills, Automations, Projects

Routes: `/api/library`, `/api/memory`, `/api/skills`, `/api/automations`, `/api/projects`, pages `/library`, `/automations`, `/projects`, `/projects/:id`.

| ID | Test | Expected | Result | Notes |
|---|---|---|---|---|
| L-01 | Ask for code / a page, open Library | Item auto-saved; open, rename, delete | | |
| M-01 | Tell Friday "remember that I prefer short answers" | Saved under Settings → Memory; used later; deletable | | |
| S-01 | Plugins → Skills: browse built-ins, create a custom skill | Appears; usable from the composer; per-plan limit enforced | | |
| S-02 | Use a skill for one message | Chip "Skill: …" shown; answer follows the playbook | | |
| AU-01 | Create an automation (daily prompt) | Runs on schedule; reply appears in its chat; push if enabled | | |
| AU-02 | Edit / pause / delete automation; per-plan limit | Works; limit message at the cap | | |
| P-01 | Create a Project with instructions; chat inside it | Project chats are scoped to it and follow its instructions | | |

### 4.4 Plugins (connected apps) and MCP

Routes: `/api/connectors/*`, `/api/mcp/*`. Providers: GitHub, Google (Gmail/Drive/Calendar), Notion, Supabase, Railway, Vercel, Razorpay, Box, Canva, finance, Jira.

| ID | Test | Expected | Result | Notes |
|---|---|---|---|---|
| K-01 | Plugins → Connect GitHub | GitHub authorize page, returns to Friday "connected" | | |
| K-02 | Connect Google; ask "what's on my calendar today" | Uses Calendar | | |
| K-03 | Token connectors (Notion, Vercel…) — paste a token | Connected; bad token gives a clear error | | |
| K-04 | Disconnect a connector | Disappears; tools no longer available | | |
| K-05 | Add an MCP server (https URL) | Tools available to the agent; per-plan limit | | |

### 4.5 Voice

Routes: `/api/voice/*`. Test: voice mode opens (**HTTPS required for the microphone**), speech-to-text fills the composer, spoken replies play. Result: ____ Notes: ____

### 4.6 Plans, billing, usage

Routes: `/api/billing/*`, `/api/usage/*`, `/api/offers/*`, pages `/plans`, `/upgrade`, public product pages `/overview /models /research /connectors`.

| ID | Test | Expected | Result | Notes |
|---|---|---|---|---|
| B-01 | Open `/plans` | Free / Pro / Premium / Enterprise with correct prices | | |
| B-02 | Settings → Usage | Shows 5-hour window, weekly and monthly use | | |
| B-03 | Buy a plan with a Razorpay **test** card | Order created, payment confirmed, plan changes | | |
| B-04 | Razorpay webhook (payment confirmed while app closed) | Plan applied anyway | | |
| B-05 | Redeem an offer code (created in back office) | Plan/discount applied; one redemption per user | | |
| B-06 | Model locked by plan | Shows lock; tapping goes to upgrade | | |

### 4.7 Legal, status, misc

| ID | Test | Expected | Result | Notes |
|---|---|---|---|---|
| G-01 | `/privacy`, `/terms` | Load without login; current policy version | | |
| G-02 | `/status` | Shows component uptime, incidents, 90-day history | | |
| G-03 | What's-new popup (after a published update) | Shown once per account | | |
| G-04 | Help & support (send a ticket) | Ticket appears in back office → Support | | |

---

## 5. Build Mode (the main new feature)

**Where:** sidebar **Build** → `/build` (home) and `/build/:conversationId` (a session). Chat never starts builds any more.

### 5.1 How it works (for testers)

1. You describe what to build (or pick a **template**, or pick a **GitHub repo + branch**).
2. Friday may ask a few **clarifying questions** (pick options or type your own).
3. Friday shows a **full plan** (what it will build, architecture, numbered steps) labelled *Waiting for your approval*. **Nothing is built, no cost, until you act.**
4. Press **Approve & build**, or type changes ("use Vue", "add login") → a **revised plan** replaces it.
5. The agent builds in an isolated cloud sandbox: writes files, installs, runs, fixes errors, checks the page in a browser, then reports. You can watch **Preview / Files / Diff / Terminal / Secrets** in the side panel.
6. Follow-ups ("make the buttons blue") on an existing project skip the plan round and edit directly.

### 5.2 Controls under the composer

| Control | Options | Effect |
|---|---|---|
| **Permission mode** | Full auto · Auto-edit · Ask every time | Full auto runs everything in the sandbox; Auto-edit edits files freely but asks before commands / connected-app actions; Ask asks before every change and command |
| **Effort** | Low · Medium · High | Low = quick (≤ 40 rounds, no browser review); High = extra test/visual passes; plan limit is always the ceiling |
| **Repo / Branch** | Connect GitHub → pick a repo (incl. private) or create one → pick or create a branch | Build clones that repo at that branch first |
| **Model** | picker in the composer | Frontier models are preferred for builds |

**Always asks, in every mode:** opening a pull request, deploy/publish commands, recursive deletes (`rm -rf`), `git push`.

### 5.3 Test cases

| ID | Test | Expected | Result | Notes |
|---|---|---|---|---|
| BM-01 | `/build` home | "Welcome back, <name>", templates, Sessions list, PR list, composer | | |
| BM-02 | Click template "Landing page" | Question round or plan appears (no build yet) | | |
| BM-03 | Answer the questions panel | Next step is the plan | | |
| BM-04 | Plan card contents | "What I'll build", Architecture (collapsible), numbered Steps, badge "Waiting for your approval" | | |
| BM-05 | Type a change in the composer | Old plan greyed "Replaced by a newer plan"; new plan appears | | |
| BM-06 | Type "yes, go ahead" instead of pressing the button | Treated as approval | | |
| BM-07 | **Approve & build** | Steps stream live; checklist ticks; preview appears | | |
| BM-08 | Preview tab | App loads in the frame; mobile-view toggle; reload; open in new tab | | |
| BM-09 | Files tab | Tree + code; download ZIP | | |
| BM-10 | **Diff** tab | Lists changed files with +/− counts, red/green lines | | |
| BM-11 | Follow-up "change the title colour to blue" | No plan round; targeted edit; Diff shows a small change | | |
| BM-12 | Permission = **Ask every time** | Allow/Deny panel before each change/command; Deny makes the agent adapt | | |
| BM-13 | "Allow all for this build" | Later steps don't ask (except always-ask items) | | |
| BM-14 | Answer an approval from a **second device** | Works (build is waiting server-side) | | |
| BM-15 | "Always asks" (ask it to open a PR / run `git push`) | Asks even in Full auto | | |
| BM-16 | **Restore to before this message** (hover your message) | Confirm dialog; files and chat go back to that point | | |
| BM-17 | Start a build, **close the tab**, reopen it from another device | Progress replayed, then follows live; result saved | | |
| BM-18 | Push notification when done / needs your OK | Arrives (needs HTTPS + push enabled) | | |
| BM-19 | **Secrets** tab: add `MY_KEY`, ask the app to read it | App reads env var; value never shown in chat/terminal (shows `[secret MY_KEY]`) | | |
| BM-20 | Secret name rules | Only `UPPER_CASE_WITH_UNDERSCORES`; delete works | | |
| BM-21 | Connect GitHub, pick repo + branch, describe a change | Repo cloned; change made on that branch | | |
| BM-22 | Create a **new repo** and a **new branch** from the pickers | Appear on GitHub | | |
| BM-23 | Ask for a pull request | Approval prompt, then PR link appears under Pull requests | | |
| BM-24 | **Deploy** button (Vercel connected) | Live `*.vercel.app` URL; secrets set as Vercel env vars | | |
| BM-25 | Deploy with Vercel not connected | Clear message "Connect your Vercel account first" | | |
| BM-26 | Stop during a build | Halts within ~2 s; session shows "Stopped" | | |
| BM-27 | Usage limit reached mid-build | Build stops with a clear message; project saved | | |
| BM-28 | Sessions list statuses | Needs input (orange) / Running (blue) / Done / Error / Stopped | | |
| BM-29 | Sidebar Recents dots; delete a build | Works | | |
| BM-30 | Sandbox expires (leave a day), reopen Preview | Project restored and restarted automatically | | |

---

## 6. Mobile apps (Android and iOS)

Both apps use the same backend and the same Build features.

| ID | Test | Expected | Result | Notes |
|---|---|---|---|---|
| MO-01 | Sign in (email + Google), accept terms | Works | | |
| MO-02 | Chat: send, stop, queue, attach, voice | Works | | |
| MO-03 | Live sync with the web app | Changes appear within seconds (uses the v2 server) | | |
| MO-04 | **+** menu contains **Deep research**; Research chip shows only while on | As described | | |
| MO-05 | Drawer → **Build**: home with templates, sessions, PRs | Matches web | | |
| MO-06 | Plan card + **Approve & build / Request changes** bar | Works; composer prompts for changes | | |
| MO-07 | Permission chip, Effort chip, Allow/Deny bar | Works; answer from phone while build runs on laptop | | |
| MO-08 | GitHub picker (connect/repo/branch/create) | Works | | |
| MO-09 | Build panel tabs: Preview, Files, Diff, Secrets, Deploy | Works | | |
| MO-10 | "Restore to before this" on a message | Works | | |
| MO-11 | Open a running build started on the web | Replays and follows live | | |
| MO-12 | Swipe/drawer gestures, keyboard, dark/light | No layout problems | | |

Install status (2026-09-30): **iOS** installed on the owner's iPhone. **Android** debug build is ready but **not yet installed** (needs the phone connected by USB). Phones on Wi-Fi with a stale DNS cache may show a Railway error — use mobile data for the first test.

---

## 7. Admin and back office (Team Console)

### 7.1 Access

- URL: **`/admin`** (and `/admin/<section>`). Hidden — not linked anywhere in the app.
- Login: username/email + password, **then an emailed code (OTP)**. The bare username `admin` maps to the owner's address.
- Who can enter: **Owner** (accounts with `profiles.role = 'admin'`, always full access) and **staff** (added under *Team & roles*, each with a role).
- Everything a staff member does in the console is written to the **Audit log**.

### 7.2 Roles (seeded) and what they can do

| Role | Permissions |
|---|---|
| **Owner / Admin** | everything (`*`) |
| **Developer** | overview, models (view+manage), updates (view+manage), support (view), tasks, audit, status (manage) |
| **Operations** | overview, users (view+manage), models (view+manage), support (view), tasks, audit, plans (manage), status (manage) |
| **Support** | overview, support (view+reply+manage), users (view), tasks, CRM (view), plans (view + **review**), status (view) |
| **Sales** | overview, CRM (view+manage), users (view), tasks, support (view), plans (view), status (view) |
| **Marketing** | overview, updates (view+manage), campaigns (view+manage+**send**), users (view), tasks, CRM (view), plans (view), status (view) |

Custom roles can be created (Team & roles). Permission matching: `*` = all, `group.*` = all in a group, otherwise exact.

### 7.3 Console sections and what to test

| Section (URL) | Needs | What it does | Key API (`/api/console/…`) |
|---|---|---|---|
| **Overview** `/admin/overview` | overview.view | KPIs: users, usage, revenue, activity | `GET /overview` |
| **Support** `/admin/support` | support.view / reply / manage | Ticket inbox: read, reply, internal notes, assign, priority, close; create a ticket on a user's behalf | `GET/POST /support`, `GET /support/:id`, `POST /support/:id/reply`, `PATCH /support/:id` |
| **CRM** `/admin/crm` | crm.view / manage | Leads & clients board, pipeline stages, contact notes/activities | `GET /crm`, `POST/PATCH/DELETE /crm/contacts…`, `POST/DELETE /crm/stages…` |
| **Tasks** `/admin/tasks` | tasks.view / manage | Team task list linked to tickets/contacts | `GET/POST/PATCH/DELETE /tasks…` |
| **Product updates** `/admin/updates` | updates.view / manage | Write, schedule and publish "what's new" announcements (shown in apps) | `GET/POST/PATCH/DELETE /updates…`, `POST /updates/:id/status` |
| **Email campaigns** `/admin/marketing` | marketing.view / manage / send | Build audience, compose, test-send, schedule/send, cancel | `GET/POST/PATCH/DELETE /campaigns…`, `/campaigns/:id/test|send|cancel`, `GET /campaigns/audience` |
| **Plans & offers** `/admin/plans` | plans.view / manage / review | Plan catalog (prices, token limits, entitlements), packages, offers/codes, access grants, redemption review | `GET /plans`, `POST /plans/packages|offers|grants`, `PATCH /plans/catalog/:id`, `POST /plans/redemptions/:id/review` |
| **Users** `/admin/users` | users.view / manage | Search users, see plan/usage, change plan or cap, **suspend / unsuspend** | `GET /users`, `GET/PATCH /users/:id` |
| **Team & roles** `/admin/team` | team.manage | Invite/remove staff, assign roles, edit role permissions | `GET/POST/PATCH/DELETE /team…`, `POST/DELETE /roles…` |
| **Team mail** `/admin/mail` | mail.manage | Manage sender identities (support@, sales@…) | `GET/POST/DELETE /mail…` |
| **Status & crashes** `/admin/status` | status.view / manage | Health checks, post incidents + updates, crash-report groups with stack traces | `GET /status`, `POST /status/incidents…`, `POST /status/checks` |
| **Models & keys** `/admin/models` | providers.view / manage | Providers, API keys (encrypted, health-checked), which models users see and their minimum plan | `/api/admin/providers/*` |
| **Billing & usage** `/admin/billing` | users.view | Usage per user/org, cost and profitability (30 days) | `/api/admin/quota/*` |
| **Audit log** `/admin/audit` | audit.view | Who did what, when | `GET /audit` |

### 7.4 Back-office test cases

| ID | Test | Expected | Result | Notes |
|---|---|---|---|---|
| AD-01 | `/admin` login as Owner (password + OTP) | Console opens with all sections | | |
| AD-02 | `/admin` as a normal user | Denied — not in the console | | |
| AD-03 | Invite a staff member with role **Support** | They can open only Support/CRM/Tasks/Overview/Users(view)/Plans(view+review)/Status(view) | | |
| AD-04 | Staff **without** a permission opens that section URL directly | Hidden / 403, not a blank page | | |
| AD-05 | Edit a role (remove one permission), staff re-login | Access removed | | |
| AD-06 | Users → search → change a user's plan | Takes effect on the user's next request (limits/model access) | | |
| AD-07 | Users → set a personal monthly cap | Enforced for that user | | |
| AD-08 | Users → **suspend** a user | User can no longer use the app; **unsuspend** restores | | |
| AD-09 | Plans → edit a plan's token limit / entitlement | Reflected on `/plans` and in the app | | |
| AD-10 | Plans → create an **offer code**, redeem it as a user | Grant appears; expiry + revoke work | | |
| AD-11 | Plans → redemption needing review (student pass) | Support role can approve/reject | | |
| AD-12 | Support: user sends a ticket (app → Help & support), staff replies | Reply reaches the user; internal note stays hidden | | |
| AD-13 | CRM: create lead → move through stages → add note | Persisted; activity log shows it | | |
| AD-14 | Tasks: create, assign, complete | Persisted | | |
| AD-15 | Updates: publish an update | Users see the "What's new" popup once | | |
| AD-16 | Campaigns: test-send, then send to a small audience | Emails delivered* ; counts update; cancel works | | |
| AD-17 | Models: add a provider key, check health, enable/disable a model, set min plan | Users' picker changes; lock icon for lower plans | | |
| AD-18 | Status: post an incident, add an update, resolve | Shows on public `/status` | | |
| AD-19 | Status: run checks; open a crash group | Results/stack shown | | |
| AD-20 | Billing & usage | Numbers match usage of test users | | |
| AD-21 | Audit log | Every action above is listed with actor and time | | |

\* Email delivery is limited by the sandbox until a sending domain is verified (§11).

---

## 8. API reference (route groups)

All under `https://friday.billionairestechnologies.com/api`. Auth = `Authorization: Bearer <access token>` unless stated. Rate limits apply to credential/OTP/refresh endpoints.

| Group | Base path | Auth | Purpose |
|---|---|---|---|
| Health | `/health`, `/health/ready`, `/health/live` | none | DB + Redis readiness |
| Auth | `/auth` | mixed | signup, login (+OTP), admin-login, Google/GitHub login, refresh, reset, policy, profile, export, delete |
| Models | `/models` | user | models the user may use |
| Chat | `/chat` | user | conversations, messages, SSE stream, stop, full-text search |
| Share | `/share` | none (token) | public read-only chat |
| Build | `/build` | user | `sessions`, `:id/preview`, `files`, `download`, `approvals`, `approve`, `checkpoints`, `restore`, `events`, `secrets`, `deploy` |
| Connectors | `/connectors` | user | connect/disconnect apps; `github/repos`, `github/branches` (list + create) |
| MCP | `/mcp` | user | user's MCP servers |
| Library / Memory / Skills | `/library`, `/memory`, `/skills` | user | saved items, long-term memory, expert playbooks |
| Automations | `/automations` | user | scheduled prompts |
| Projects / Organizations | `/projects`, `/organizations` | user | project workspaces; enterprise orgs, seats, invites |
| Voice / Sandbox / Files | `/voice`, `/sandbox`, `/files` | user | speech, code-run sandbox, generated documents |
| Usage / Billing / Offers | `/usage`, `/billing`, `/offers` | user | quota status, Razorpay orders/webhook, offer redemption |
| Push | `/push` | user | web/mobile push registration |
| Support / Updates / Email | `/support`, `/updates`, `/email` | mixed | tickets, what's-new feed, unsubscribe/preferences |
| Status | `/status` | none | public status page data, crash-report intake |
| App | `/app` | none | app version / update info for mobile |
| **Console** | `/console` | staff permissions | back office (table in §7.3) |
| **Admin** | `/admin/providers`, `/admin/quota` | admin | providers/keys, usage & profitability |

**Live stream (SSE) events** used by the clients: `status, text, think, cite, step, plan, ask, approval, preview, build, suggest_build, meta, file, agent, err, done`. Clients must ignore unknown events.

Quick smoke test (replace `TOKEN`): `curl -s https://friday.billionairestechnologies.com/api/health` → `{"status":"ready",…"database":"ok","redis":"ok"}`.

---

## 9. Plans, limits and entitlements (defaults; editable in back office → Plans)

| | Free | Pro | Premium | Enterprise |
|---|---|---|---|---|
| Price / month | ₹0 | ₹999 | ₹1,999 | ₹2,499 per seat (min 3) |
| Tokens per 5 h | 50K | 500K | 1.2M | pooled (none) |
| Tokens per week | 250K | 2.5M | 6.25M | pooled |
| Tokens per month | — | 10M | 25M | 35M per seat, pooled |
| Build Mode | yes (trial-level) | yes | yes | yes |
| Build max rounds | 30 | 100 | 150 | 150 |
| Deep Research / day | 3 | 40 | 150 | 300 |
| Documents / day | 5 | 100 | 300 | 500 |
| Custom skills | 3 | 25 | 100 | 200 |
| Library storage | 500 MB | 10 GB | 50 GB | 100 GB |
| Team Up models | 3 | 5 | 8 | 8 |
| MCP servers | 2 | 10 | 25 | 25 |
| Automations | 3 | 20 | 50 | 50 |
| Priority support | no | no | yes | yes |

**Open product decision:** which plans should get Build Mode (today all plans have it). The owner will decide after testing.

---

## 10. System management (Ops)

### 10.1 Components on the server

| Container | Role | Public? |
|---|---|---|
| `caddy` | HTTPS proxy, automatic Let's Encrypt certificates, routes `/auth /rest /storage /realtime` to Supabase and the rest to the app | yes (80/443) |
| `friday` | The app (Node 22 + React bundle), port 4000 | via Caddy |
| `redis` | Rate limits, quota counters, locks (256 MB cap) | no |
| `supabase-envoy` | Supabase API gateway (port 8000, loopback) | via Caddy |
| `supabase-db` | Postgres 17 | no |
| `supabase-auth / rest / storage / realtime / meta / studio / imgproxy / edge-functions / pooler` | Supabase services | no |

Security group allows **only 80 and 443**. There is **no SSH**; use AWS Systems Manager (Session Manager / Run Command) on instance `i-0414cc992c753285f`.

### 10.2 Where things live (on the server)

| Path | What |
|---|---|
| `/opt/supabase/` | Supabase compose project. `.env` holds its secrets — **never print or share it** |
| `/opt/supabase/docker-compose.friday.yml` | Friday overrides (loopback ports, gateway on the app network) |
| `/etc/caddy/Caddyfile` | Proxy config (older versions: `.bak`, `.pre-domain`) |
| `/usr/local/bin/friday-backup` + `/etc/cron.d/friday-backup` | Nightly backup job (21:17 UTC) |
| `/var/log/friday-backup.log` | Backup log |
| `/opt/friday-migrations/` | Database migrations applied to this server |
| `/opt/friday-export.sh`, `friday-load.sh`, `friday-files.sh` | One-time copy scripts from the old database — **they wipe local tables; never run on the live system** |

### 10.3 Secrets and settings

- App settings: AWS Secrets Manager **`friday/app-env`** (one JSON; the app reads it at start as `FRIDAY_ENV_JSON`). Changing it needs an app restart; changing `SUPABASE_URL` / `VITE_SUPABASE_*` also needs a **rebuild** (baked into the web bundle).
- `friday/app-env-supabase-cloud`: rollback copy of the retired supabase.com settings (delete after the retirement period).
- Names of settings (values are secret): `SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, KEY_ENCRYPTION_SECRET, PUBLIC_APP_URL, PUBLIC_API_URL, CORS_ORIGIN, RESEND_API_KEY, RESEND_FROM_EMAIL, STATUS_ALERT_EMAILS, SUPPORT_INBOUND_SECRET, RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET, GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET/REDIRECT_URI, E2B_API_KEY, TINYFISH_API_KEY, VAPID_*, FCM_SERVICE_ACCOUNT_JSON, provider API keys (OpenAI, Anthropic, Gemini, OpenRouter, ScaleMax, Sarvam, Ollama, ElevenLabs), FRIDAY_* app/version settings`.
- Secrets written into Friday at rest (connector tokens, provider keys, project secrets) are encrypted with `KEY_ENCRYPTION_SECRET` — **losing that value makes them unreadable; back it up separately.**

### 10.4 Deploying a new version

1. Commit to `main` (kept equal to `v2`).
2. Zip the commit, upload to `s3://friday-build-sourcebucket-cs9tgswn3g8g/source.zip`.
3. Start CodeBuild project **`friday-build-image`** with `IMAGE_TAG=<12-char commit>`; wait for SUCCEEDED (≈4 min). Image lands in ECR `friday-build-app:<tag>`.
4. On the server (Run Command): pull the image, rename the running `friday` container to `friday-old`, start a new `friday` with the same flags (`--network friday --restart always --stop-timeout 120`, env `NODE_ENV=production PORT=4000 TRUST_PROXY=1 REDIS_URL=redis://redis:6379 FRIDAY_ENV_JSON=<secret JSON>`), check `curl -H 'Host: 13.200.53.44' http://127.0.0.1/api/health` = 200, then remove `friday-old` — or rename back and start it to **roll back**.
5. Note: a redeploy **interrupts any chat/build stream in progress**; deploy off-peak.
6. Database changes: add a numbered file in `supabase/migrations/`, run `npm run verify:migrations`, and **apply it manually** on the server (`docker exec -i supabase-db psql -U postgres -d postgres < file.sql`).

Repository checks before every push: `npm run verify:migrations`, backend/frontend typecheck, backend tests (149), both production builds. **Warning:** `.gitignore` excludes any folder named `build/` — such folders are silently not committed.

### 10.5 Monitoring and logs

| What | How |
|---|---|
| Liveness/readiness | `GET /api/health` (checks DB + Redis); public `/status` page; console → Status & crashes |
| App logs | `docker logs friday` (request lines include `request_id`; errors are JSON with `"level":"error"`) |
| Proxy logs | `docker logs caddy` (TLS/cert and upstream errors) |
| Supabase logs | `docker logs supabase-db` / `supabase-auth` / `supabase-storage` / `realtime-dev.supabase-realtime` |
| Resources | `docker stats --no-stream`, `uptime`, `free -m`, `df -h /` (30 GB disk, ~41% used at launch; 8 GB RAM, ~2.5 GB in use) |
| Alerts | set `STATUS_ALERT_EMAILS` for incident mail; consider CloudWatch alarms on CPU/disk/status checks (not yet configured) |

Normal numbers at launch: load < 1, API responses ~0.1–0.2 s, database ~30 MB + ~19 MB files.

### 10.6 Backups and restore

- **Backup:** nightly 21:17 UTC (02:47 IST): full Postgres dump (custom format: `public`, `auth`, `storage` schemas) + stored-files archive → `s3://friday-v2-backups-095713295449/<timestamp>/db.dump` and `storage.tgz`. Bucket is private, encrypted, versioned, **30-day expiry**.
- Manual run: `sudo /usr/local/bin/friday-backup`.
- **Restore (to test — not yet rehearsed):** download `db.dump`, `docker exec -i supabase-db pg_restore -U supabase_admin -d postgres --clean --if-exists --no-owner < db.dump`; unpack `storage.tgz` into the storage volume; restart Supabase. **Do this first on a scratch copy.**
- Also recommended: EBS snapshot schedule for the server disk (not configured yet).

### 10.7 Kill switches (set in `friday/app-env`, then restart the app)

`FRIDAY_DISABLE_TOOLS=1` (agent tools off, plain chat), `FRIDAY_DISABLE_AUTOMATIONS=1`, `FRIDAY_DISABLE_CAMPAIGNS=1`, `FRIDAY_DISABLE_GRANT_EXPIRY=1`, `FRIDAY_DISABLE_STATUS_MONITOR=1`, `FRIDAY_PROMPT_CACHE=off`, `FRIDAY_BUILD_NATIVE_TOOLS=off` (Build falls back to text-tag protocol).

### 10.8 DNS, HTTPS, domains

- `friday.billionairestechnologies.com` → A `13.200.53.44` (TTL 300) in Squarespace DNS. Certificates are issued and renewed automatically by Caddy (Let's Encrypt).
- OAuth/payment callbacks already use this domain (GitHub `/api/connectors/github/callback`, Google login/connector callbacks, Razorpay webhook).
- Email (Resend) DNS records (`resend._domainkey`, `send`) exist in the same DNS zone.

### 10.9 Security notes for reviewers

- Public surface: only 80/443; Postgres, Studio, Redis are not exposed.
- Supabase public signup is **disabled** — accounts are created only through Friday's backend.
- Row-level security is on for every table; the backend uses the service key. Tables added in v2: `build_checkpoints`, `build_events`, `build_secrets` (all backend-only).
- Build sandboxes are isolated per user (E2B); GitHub/Vercel tokens reach sandboxes only as environment variables of server-built scripts and are scrubbed from output.
- Project secrets are encrypted at rest and redacted from every output shown to the model or the user.
- Sessions issued by the old database are invalid (different signing key) — by design.
- To review: IAM policy scope (the server role can read the app secret and write the backup bucket only), rotation of keys that were shared in chat during setup, enabling CloudWatch/SNS alerts, EBS snapshots, WAF/rate limits at the edge.

### 10.10 Rollback to the old setup (emergency)

1. In Squarespace DNS set `friday` back to CNAME `3h0ea5s4.up.railway.app` (old TTL applies).
2. In Railway clear the `friday` service's custom start command and redeploy (branch `v1` is the old code).
3. The old database (supabase.com project `friday-ai`) still holds data as of 2026-09-30 ~15:50 IST — anything written on v2 after that is **not** in it.
(Keep this option for about a week, then retire Railway and supabase.com.)

### 10.11 Cost notes

One EC2 instance (covered by AWS credits/free tier), one Elastic IP in use, S3 backups (small), CodeBuild per deploy. An **unused second Elastic IP (`13.207.78.77`)** is billed while idle — release it. External pay-per-use: AI providers, E2B sandboxes, Resend, Razorpay fees.

---

## 11. Known limitations and open items

| # | Item | Impact | Owner |
|---|---|---|---|
| 1 | Email provider in **sandbox** — cannot email arbitrary addresses until a sending domain is verified | New-user OTP, password reset and campaigns may not arrive | Owner (verify domain in Resend) |
| 2 | Plan-gating for Build Mode undecided | All plans currently have it | Owner |
| 3 | Android build not yet installed on a phone; Android/iOS release channels (Play/TestFlight) not updated | Mobile testing limited to sideloaded debug builds | Owner / Dev |
| 4 | Backup **restore not yet rehearsed**; no EBS snapshots; no CloudWatch alarms | Recovery time unproven | Ops |
| 5 | DNS caches: some users reach the old address until ~19:00 IST on cutover day | Temporary errors for those users | — |
| 6 | Everyone must sign in again and re-accept terms once; GitHub must be re-connected | One-time friction | — |
| 7 | Full real-world Build runs with approval prompts and Vercel deploy not yet exercised end-to-end by a human | Needs QA focus (§5.3) | QA |
| 8 | Push notifications need HTTPS + subscribed device | Test on real devices | QA |
| 9 | Single server (no redundancy); redeploy interrupts live streams | Brief outage possible during deploys | Ops |
| 10 | Old services (Railway, supabase.com) still exist for rollback | Delete after ~1 week of stable use | Owner |

---

## 12. Defect log (copy one row per issue)

| Bug ID | Area / ID from tables | Steps to reproduce | Expected | Actual | Severity (S1 blocker / S2 major / S3 minor / S4 cosmetic) | Platform / browser | Screenshot / link | Reported by | Status |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |
| | | | | | | | | | |
| | | | | | | | | | |

## 13. Review notes (fill in and send back)

**Testing team summary**

- What worked well: 
- Main problems found: 
- Areas not covered: 
- Recommendation:  ☐ Go  ☐ Go with fixes  ☐ No-go

**System management summary**

- Infrastructure findings: 
- Security findings: 
- Monitoring / backup / recovery findings: 
- Recommendation:  ☐ Go  ☐ Go with fixes  ☐ No-go

**Back-office (admin) findings**

- Roles & permissions: 
- Users / plans / offers: 
- Support / CRM / campaigns: 
- Status / audit: 

**Other comments**

- 

| Sign-off | Name | Date | Signature |
|---|---|---|---|
| QA lead | | | |
| Ops lead | | | |
| Product owner | | | |
