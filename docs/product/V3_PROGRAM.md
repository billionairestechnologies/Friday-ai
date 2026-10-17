# Friday v3 program — control centre, experience engine, artifact studio

Source brief: *Friday Ecosystem — Complete Master Implementation Prompt* (owner, 2026-10-17).
This file is the working plan and the honest status board for that brief. Update the status
columns in the same PR that changes them; "done" means implemented, tested and merged into `v3`.

## Branching (how this program is run)

| Branch | Purpose | Who merges |
|---|---|---|
| `main` | **Production.** Every push auto-deploys to EC2 (`.github/workflows/ci.yml`). | Release only, on the owner's say-so |
| `v3` | Integration branch for this program. Always green (`npm run verify`). | PRs from phase branches |
| `feat/v3-NN-topic` | One branch per phase slice (NN = phase number below), cut from `v3`. | PR → `v3`, CI must pass |
| `fix/*` | Production hotfix, cut from `main`, PR → `main`; then merge `main` back into `v3`. | Owner |
| `v2` | Frozen previous production line (was `main` until 2026-10-17). | — |

Rules: never push straight to `main`; migrations are numbered in the branch that adds them and are
applied to production **by hand before** the release that needs them (CI never runs SQL); a slice
is mergeable only with tests for its new behaviour and a green `npm run verify`.

## What already exists (audit, 2026-10-17, branch `v3` @ bae289b)

Friday is one Express/TS backend + React SPA + Android/iOS + the FridayX CLI/IDE, all on one
Supabase identity. The brief's "three products" share auth, entitlements and the token ledger
already (`middleware/cliAuth.ts` checks the same `fridayX` entitlement; the CLI gateway meters
through the same `UsageMeter`). Inventory against the brief:

| Brief § | Area | State | Where |
|---|---|---|---|
| 4 | Admin control centre shell | **Exists** — Team Console, 18 sections, RBAC per route | `frontend/src/console`, `routes/console.ts` |
| 24 | RBAC + audit log | **Exists** — data-driven roles, `admin_audit_logs` | `console/permissions.ts`, `usageService.recordAdminAuditLog` |
| 1.2 | Usage ledger (must not be replaced) | **Exists, authoritative** — Postgres `quota_*` functions, idempotent `token_ledger` | `supabase 0057`, `services/quota/*` |
| 5 | **Model-wise usage multipliers** | **Built in 03a** — versions, schedule, promos, preview, history, stored per ledger row | `quota/multipliers.ts`, `0059` |
| 6 | Credit grants / corrections | **Built in 03b** — grants with expiry that outlive the month, approval threshold, bulk with preview, revoke, user notice | `quota/credits.ts`, `0060` |
| 7 | Offers | **Built in 04** — atomic redemption (fixes a double-apply race), bonus-credit offers, draft/active/paused/archived, stacking groups, headline/terms | `plansService.ts`, `0061` |
| 8 | Student / startup / company programs | **Built in 04** — applications with private evidence, review (approve / info / reject, exactly once), per-programme benefit, re-verification expiry | `programService.ts`, `0061` |
| 9 | Pop-ups / announcements | **Built in 05** — atomic display claim (once per person per version, across tabs/devices), state tracking, new-version re-show, banner variant, benefit popups, inbox, consent-aware benefit email | `announcementService.ts`, `notificationService.ts`, `0062` |
| 10 | Email campaigns | **Exists** — audience, test, schedule, send ledger, signed unsubscribe (Resend); delivery webhooks unverified | `campaignService.ts` |
| 11 | Customer profiles | **Partial** — user lookup, plan, usage; no unified timeline, sessions | `Users` section |
| 12 | Finance | **Built in 06** — payment ledger (payments, refunds, chargebacks, fees), cash vs earned (straight-line) vs deferred, margins, burn, break-even, credit exposure, reconciliation; every figure labelled actual / entered / calculated / estimate | `finance/summary.ts`, `0063` |
| 13 | Provider/model registry + health | **Exists** — keys, health, provider issues, status page | `adminProviders`, `services/status` |
| 14–15 | Response experience engine + components | **Built in 07** — `friday-chart` / `friday-experience` data blocks (allow-listed, validated on server and client, readable fallback), chart component, model guidance ("don't force it") | `structuredBlocks.ts`, `lib/experiences`, `components/experiences` |
| 16–19 | Artifact studio + documents | **Partial** — Pages with versions + CAS, pptx/xlsx/docx/pdf render, edit-in-same-format | `services/pages`, `services/documents` |
| 20 | File storage security | **Partial** — owner-scoped storage, SSRF guard; no content sniffing / malware scan | `attachmentStorage.ts` |
| 21 | Image edit continuity | **Missing** — generation only | — |
| 22 | Jobs / turn lifecycle | **Partial** — `active_turns` heartbeat + resume; stream stall watchdog (bae289b) | `services/jobs` |
| 23 | Device/session limits | **Missing** (policy decision needed before enforcing caps) | — |
| 26 | Observability | **Partial** — status probes, provider issues, crash reports, structured logger | `services/status` |
| 36 | Interactive gallery + offside simulator | **Built in 07** — /gallery (search, categories), offside simulator (drag, keyboard, boundaries tested), EMI calculator, projectile explorer; shareable state in the URL | `routes/gallery.tsx` |
| 37–38 | Power Skills (manifests, permissions, evals) | **Partial** — 16 built-in playbooks + user skills, `use_skill`; no manifest schema, versions, permissions, evals | `services/skills` |
| 1.2 | Public pay-as-you-go API | **Out of scope** (not touched) | — |

## Phase plan (each line = one or more `feat/v3-NN-*` PRs)

| # | Slice | Depends on | Status |
|---|---|---|---|
| 03a | Model usage multipliers: versioned, scheduled, promo overrides, preview, history, applied value stored per ledger row | ledger 0057 | **Merged into v3** (PR #4); needs migration 0059 on prod before release |
| 03b | Credits: bulk grants with preview + caps, expiry, approval threshold, grant → notification + push (popup in 05, email in 05) | 03a | **Merged into v3** (PR #5); needs migration 0060 on prod before release |
| 04 | Offers v2 (credits, states, stacking, atomic redemption) + student/startup/company programmes | 03b | **Merged into v3** (PR #6); needs migration 0061 on prod before release |
| 05 | Benefit popups + versioned one-time campaigns + inbox + benefit email (web; Android/iOS keep the old /updates/seen path) | 04 | **Merged into v3** (PR #7); needs migration 0062 on prod before release |
| 06 | Finance actuals: payment ledger, cash vs earned vs deferred, margins, burn, break-even, reconciliation | — | **Merged into v3** (PR #8); needs migration 0063 on prod before release |
| 07 | Experience engine: structured chart/experience blocks, gallery, offside simulator, EMI, projectile | — | **PR open** (`feat/v3-07-experiences`); no migration |
| 08 | Artifact studio: unified artifacts over Pages + files, diff/restore, NL targeted edits | 07 | planned |
| 09 | Reliability: image asset lineage + edit routing, job states, load test on staging | — | planned |
| 10 | Power Skills: manifest schema, versions, declared permissions enforced server-side, eval harness, Skill Builder | 07 | planned |
| 11 | Sessions & devices: registry across web/CLI/IDE, revocation, user device page (policy first) | — | needs owner policy |

## Blockers that need the owner (not code)

- **Device / concurrent-session caps** (§23): the numbers and the enforcement policy.
- **Credit ↔ money policy** (§7 "$100 offer"): how many billable tokens one rupee/dollar of bonus buys.
- **Staging environment** for load tests and payment-webhook tests (no staging exists; prod only).
- **Razorpay / Resend webhooks** live verification needs their dashboards.
