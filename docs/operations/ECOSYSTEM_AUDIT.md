# Friday ecosystem implementation audit

**Repository inspection:** 17 October 2026. This report describes the checked-out workspace only. No production account, cloud console, database, deployment pipeline, DNS zone, or provider account was available for inspection, so deployment state and live financial/operational figures are **unknown**.

## Architecture found

- **Friday AI:** React 19 + Vite + TanStack Router frontend; Node.js 22+ / Express / TypeScript API; Supabase Auth, Postgres, and Storage; optional Redis for shared limits. The server holds the Supabase service role and provider credentials.
- **FridayX:** Rust CLI and VS Code/IDE integrations authenticate through the backend device authorization flow. CLI gateway calls use backend model routing and the existing central usage/entitlement path.
- **Admin:** `/admin` is a code-split Team Console. Backend permission middleware checks staff roles; finance, provider, user, team, audit, support, and status functions already exist. The existing overview includes real counts and activity, but does not provide all executive/financial measures requested in the specification.
- **Organizations and identity:** Supabase Auth is the common identity provider. Organization membership/invites and CLI sessions have dedicated routes/services. Standard web sessions are Supabase tokens; the auth middleware caches verified user/profile data for 45 seconds.
- **AI and context:** Provider adapters, server-side routing, chat conversations/messages, attachments, memory, and build project context are present. Vendor-output scrubbing and upstream error sanitization exist. The image provider integration supports generation; a full durable image edit/version lifecycle was not confirmed in this inspection.
- **Background work:** `active_turns` records with heartbeats and stale-turn recovery exist for chat/research/build. Build turns can resume under limits; chat/research are reported interrupted because they are unsafe to replay. This is not a general durable queue with tenant-fair scheduling or dead-letter management.
- **Finance:** Existing finance services cover configured model pricing, estimated usage cost, expenses, and reports. The inspected code does not establish a verified payment/revenue ledger sufficient to calculate MRR, ARR, collected revenue, refunds, or profit as accounting actuals.
- **Database/migrations:** Supabase SQL migrations are numbered through 0051 in this workspace. The current working tree has pre-existing uncommitted edits in backend provider/token-usage files and a new 0051 token allowance migration. These were preserved; the quota implementation was not changed.
- **Hosting/operations:** AWS/Railway-oriented deployment and operations documentation exists. Actual hosting, DNS, TLS, backup configuration, alert delivery, and live deployment status were not independently verified.

## Preserve

- Supabase identity and tenant-scoped data model; existing subscriptions and entitlement/token accounting.
- The current Team Console, organization features, provider registry, finance tools, CLI device flow, and durable active-turn recovery.
- Existing provider integrations and customer-facing product design.

## Findings and risks

### Addressed in this change

- HTTP access logs used Morgan's `:url`, which includes query parameters. OAuth authorization codes and verification codes in callback URLs could therefore be copied into access logs. Morgan now logs only `req.path`.
- Unhandled server errors logged `req.originalUrl` and the full exception stack. This could expose query credentials, provider response bodies, or sensitive content. The handler now logs the path, request ID, method, and error class only; user responses remain sanitized.

### Remaining security/reliability risks

- Web auth/profile data is cached for 45 seconds, so revocation and role changes may take up to that long to affect normal API requests. CLI session revocation is a separate mechanism. A unified immediate revocation policy across HTTP streams, WebSockets, CLI, IDE, and running jobs is not established.
- A central structured logger exists, but repository-wide direct `console.*` calls remain, including some paths that log search terms, tool/provider failures, or debug model output. Avoid enabling debug flags in production until those paths are reviewed and replaced with redacted structured events.
- `active_turns` is a recovery mechanism, not exactly-once job execution. A stale build may be resumed; retry billing, duplicate upstream side effects, lease fencing, and cancellation after account/session revocation require end-to-end validation.
- Client sessions are not a single device registry across browser, CLI, and IDE. Do not activate the specification's suggested device/concurrency defaults without product and support policy decisions.
- Admin permission checks are present, but broad roles and high-impact actions need a route-by-route authorization and audit review. Some audit writes are intentionally fire-and-forget.
- Organization membership exists; company invitation and role workflows need verification against privacy boundaries. The audit did not confirm any organization admin access to personal conversations.
- Existing image generation and attachments do not prove tenant-safe, versioned iterative image editing. Do not represent this feature as complete.
- Finance reports contain estimates based on configured rates/usage. Actual revenue, refunds, chargebacks, infrastructure invoices, currency conversion, and recognized revenue require verified integrations or source records.
- Migrations can be checked locally, but application against staging/production and rollback/restore safety cannot be established from this checkout.

## Implementation phases and likely files

1. **Baseline:** run migration verification, type checks, backend tests, and builds. Inspect actual diffs first because token-related changes are already in progress.
2. **Security:** continue log redaction and remove raw content from direct logs (`backend/src/app.ts`, middleware, provider/chat/agent services); verify output and upstream error safeguards; audit privileged routes and long-lived CLI credentials.
3. **Identity and tenancy:** define revocation semantics, then implement/test shared device/session records and server-side enforcement across web, streams, CLI, IDE, and jobs. Likely `middleware/auth.ts`, `middleware/cliAuth.ts`, `services/cli/*`, migrations, and client settings.
4. **Request/context/image lifecycle:** inspect chat persistence and attachment ownership, then add durable task/artifact version relationships only where current schema lacks them. Likely `services/chat/*`, `services/attachmentStorage.ts`, migrations, and chat UI.
5. **Jobs/scaling:** define replay safety and admission/fairness requirements before extending `services/jobs/*`; load test staging with approved provider budgets.
6. **Admin/finance/observability:** extend the existing console and finance services only for metrics backed by verified source records; expose unavailable data as unavailable. Likely `services/console/*`, `services/finance/*`, `controllers/financeController.ts`, and console sections.
7. **Launch:** staging migration/restore, regression/security tests, measured load, alert validation, rollback rehearsal, and a production readiness review.

## Dependencies and blockers

- Staging/production Supabase access, sanitized schema/data samples, and deployment configuration are needed to verify applied migrations, RLS, backups, query performance, and real dashboards.
- Business policy is needed before enabling device/session caps, organization subscription conversion, risk-triggered restrictions, and financial recognition rules.
- Provider pricing/usage sources and billing/payment records are needed for actual cost/revenue reporting; otherwise those fields must remain unavailable or explicitly estimated.
- Test credentials and an approved staging budget are needed for provider, payment webhook, multi-user, and load tests. No production load test or deployment was run.

## Status checklist

- **Completed here:** repository inventory; initial architecture/security audit; access/error log query and stack minimization.
- **Partially complete in repository before this task:** admin console, server-side permission checks, finance estimates/expenses, organization membership, CLI sessions, provider adapters, auth, tenant-oriented data paths, active-turn recovery, health endpoints, and operational documentation. Presence is not equivalent to end-to-end acceptance.
- **Not verified:** production configuration/deployment; live financial actuals; full account/device lifecycle; all cross-product revocation; adversarial security suite; image edit/version flow; durable fair queue; restore procedure; alert delivery; sustainable concurrency.
- **Out of scope and not introduced:** public pay-as-you-go API platform, public API keys/portal/billing, and a replacement token ledger.

## Local verification and release guidance

Run `npm run verify:migrations`, `npm run typecheck`, `npm test`, and `npm run build` from the repository root. Review the pre-existing token/quota diff separately before merging. Apply migrations to staging first, validate data and restore procedures, and only then consider production. Roll back application code first; use forward migrations for data/schema corrections. This repository-only change does not constitute deployment or launch approval.
