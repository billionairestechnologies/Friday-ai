# Friday AI operations runbook

## Release gate

Run these checks before deploying:

```bash
npm run verify:migrations
npm run typecheck
npm --prefix backend test
npm run build
```

CI runs the same checks on pull requests and pushes to `main`.

## Environment

On AWS, see `docs/operations/AWS_DEPLOY.md` — all of the settings below go into one Secrets Manager secret.

Production must set:

- `NODE_ENV=production`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `KEY_ENCRYPTION_SECRET` with at least 32 unique bytes
- `RESEND_API_KEY`
- `CORS_ORIGIN`
- `TRUST_PROXY` when behind a reverse proxy
- `REDIS_URL` when running more than one API instance
- `PUBLIC_APP_URL` / `PUBLIC_API_URL` for OAuth redirects
- Razorpay + GitHub connector secrets when those features are enabled

Optional:

- `E2B_API_KEY` — Build Mode sandboxes and the chat `run_code` tool
- `TINYFISH_API_KEY` — primary web search (DuckDuckGo is the fallback)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google login + connector (also refreshes connector tokens)
- `FRIDAY_DISABLE_TOOLS=1` — kill switch: chat skips the agent tool loop (plain streaming)
- `FRIDAY_DISABLE_AUTOMATIONS=1` — stop the in-process automation scheduler on this instance
- `FRIDAY_PROMPT_CACHE=off` — disable Anthropic/OpenAI/Gemini prompt caching (on by default)
- `FRIDAY_BUILD_NATIVE_TOOLS=off` — Build Mode back on the text-tag protocol
- `FRIDAY_BUILD_STAGED_FLOW=on` — Build back on the forced question → plan → build rounds (default: the
  model decides to answer / ask_user / propose_plan / build, like Claude Code)
- `FRIDAY_BUILD_MODELS` — regex replacing Build's frontier-model allow-list (`projectBuild/buildModels.ts`)
- `MAILCOW_URL`, `MAILCOW_API_KEY` (+ optional `MAIL_SERVER_HOST`) — company mail hosting on our own
  mailcow server: Team Console → Mail hosting creates employee mailboxes; Mailbox is the webmail
  (see `docs/operations/MAIL_HOSTING.md`). Migrations `0040` (finance) and `0041` (mail) must be applied.
- `FRIDAY_DRAIN_SECONDS` (default 20) — on deploy/stop, running turns get this long to finish before they are
  handed over (keep it under the platform's kill timeout); `FRIDAY_DISABLE_TURN_RESUME=1` stops the sweeper
  that resumes interrupted Builds and reports interrupted chats (migration `0042_add_active_turns`)
- Project knowledge (files a project's chats search): migration `0043_add_project_knowledge` needs the
  `vector` extension (Supabase: enabled by the migration). Embeddings use the OpenAI or Gemini key from
  Models & keys; with neither, search is full-text only. `FRIDAY_DISABLE_EMBEDDINGS=1` forces text-only.
- Browser agent (`browser` tool): needs `E2B_API_KEY` (one sandbox per chat, 10 min idle); turn it off
  with `FRIDAY_DISABLE_BROWSER=1`
- Pages (live docs / sheets / slides, `/pages`, share links at `/p/:token`): migration `0044_add_pages`
- `FRIDAY_SANDBOX_PERSIST=off` — kill Build sandboxes on timeout instead of pausing them (default: pause,
  so the next message resumes with node_modules + the project's git history; paused sandboxes are billed
  as E2B storage)
- `STATUS_ALERT_EMAILS` — comma-separated inboxes for outage alerts and /status problem reports
  (falls back to the team's `support` mail identity, then the console owners)
- `SUPPORT_INBOUND_SECRET` — shared secret for the inbound-email webhook (`POST /api/support/inbound`)
  that turns emails to your support address into tickets
- `FRIDAY_DISABLE_STATUS_MONITOR=1`, `FRIDAY_DISABLE_CAMPAIGNS=1`, `FRIDAY_DISABLE_GRANT_EXPIRY=1` —
  stop the status probes / campaign sender / access-grant expiry sweep on this instance

Optional provider keys are managed through the admin panel. Missing provider keys should degrade
model availability, not process startup.

## Migrations

Apply every SQL file under `supabase/migrations/` in numeric order before deploying backend code
that depends on it. Branch `v2` needs everything through `0036_add_skills.sql`; `feature/build-agent-loop`
needs everything through `0044_add_pages.sql`.

Recommended deploy order:

1. Apply new migrations against staging.
2. Run the application verification checks against staging.
3. Apply new migrations against production.
4. Deploy the backend/frontend image.
5. Check `/api/health/ready`.

Rollback code first. Roll database state forward with a corrective migration rather than manually
editing existing migration files after they have reached production.

## Health checks

- `/api/health/live` confirms the process can answer HTTP.
- `/api/health/ready` and `/api/health` confirm the process is not draining and Supabase is reachable.

Use readiness for load balancers and deploy gates. Use liveness only for process restarts.

## Backups and restore

Enable Supabase point-in-time recovery for paid production projects. For launch, rehearse restore
into a staging project before every major schema change:

1. Restore the latest production backup into staging.
2. Apply pending migrations.
3. Start the app against staging.
4. Verify login, chat history, attachment reload, export, and deletion.

Keep the latest successful restore timestamp in the release notes.

## Incident response

For provider-cost or abuse incidents:

1. Disable affected models or provider keys in the admin panel.
2. Reduce relevant rate-limit environment values.
3. Restart the API after config changes.
4. Export logs filtered by `request_id` and user id where available.
5. Add a regression test or limiter before re-enabling capacity.

For failed deploys:

1. Remove the new instance from readiness.
2. Roll back to the previous image.
3. Confirm `/api/health/ready`.
4. Ship a forward migration or patch branch for data fixes.

## Current limitations

- Set `REDIS_URL` for multi-instance deployments. Without it, rate and concurrency limits are
  per-process and fall back automatically if Redis is unreachable.
- Attachments prefer Supabase Storage (`message-attachments` bucket) when
  `ATTACHMENT_OBJECT_STORAGE=true`. Inline `data_url` remains as a fallback for failed uploads.
- Provider cost telemetry records `token_usage` events from stream usage when available, with a
  conservative character-based estimate fallback. Figures are for budgets, not invoices.
- GitHub and Google (Calendar/Gmail/Drive) use OAuth. Notion, Supabase, Railway, Vercel,
  Razorpay, Box, Canva, and Finance accept verified user tokens, encrypted at rest.
- Google sign-in is live when `GOOGLE_CLIENT_*` are set (`GET /api/auth/google/start`).
- SSO is entry-point ready via `SSO_ENABLED` / `SSO_ENTRY_URL` (and `/api/auth/sso`); configure the IdP in Supabase Auth. Team invites can be accepted from Settings or `?invite=`.


## Team Console (/admin)

- **First owner**: any account with `profiles.role = 'admin'` is an owner. Sign in at `/admin`, then
  invite teammates from *Team & roles* (they need a Friday account first). Roles are data
  (`staff_roles`); each grants permission strings like `support.reply` or `plans.manage`, and the API
  enforces them on every console route.
- **Mail**: set `RESEND_API_KEY`, then add your addresses under *Team mail* (e.g. support@, hello@).
  Campaign and support mail send from the identity with the matching purpose. Unsubscribe links are
  signed; `profiles.marketing_opt_out` is respected by every campaign audience.
- **Plans & offers**: edit prices, limits and entitlements under *Plans & offers → Plans* (cached ~1
  minute). Public packages appear on `/plans` and are bought through Razorpay; the webhook applies
  them as access grants, and the hourly sweep reverts grants that end.

## Status page and incidents

- `/status` is public. Every 5 minutes one instance (Redis lease) probes the API, database, Redis,
  email and each model provider; results live in `status_checks` (120-day retention, same as
  `crash_reports`).
- Two failed probes in a row open an automatic incident and email the alert list; two passes resolve
  it. Post manual incidents and updates from *Status & crashes* in the console — they show on
  `/status` immediately.
- "Report a problem" on `/status` creates a high-priority support ticket, emails the reporter a
  confirmation and alerts the team. Web crashes arrive grouped by fingerprint under *Crashes*.
