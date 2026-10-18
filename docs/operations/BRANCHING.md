# Branching

One long-lived branch: **`main`**. Everything else is a short-lived task branch that is merged and deleted.

`main` auto-deploys to production on every push (see [EC2_DEPLOY.md](EC2_DEPLOY.md)), so it must always be
releasable. Nothing goes to `main` except through a pull request with green CI.

## Why not v1 / v2 / v3 or one branch per module

Until 2026-10-18 the repo had `v1`, `v2` and `v3` branches next to `main`. Nobody could tell which one was
live, fixes landed on one line and not the others, and a push to the wrong branch overwrote production.
Permanent per-module branches (`usage-meter`, `build-mode`, …) fail the same way: they drift from `main`
and every merge becomes a big, risky one. So module ownership lives in branch **names** and code review,
not in long-lived branches.

The old lines are kept as **tags** `v1`, `v2`, `v3` (`git checkout v2` still works, read-only).

## Module branches

Each part of the repo has a standing branch, created from `main` on 2026-10-18:

| branch | folder / scope |
|---|---|
| `module/backend` | `backend/` (API, agents, quota, console services) |
| `module/frontend` | `frontend/` (web app, Team Console UI) |
| `module/android` | `android/` |
| `module/ios` | `ios/` |
| `module/cli` | `cli/` (FridayX terminal agent) |
| `module/ide` | `ide/` (VS Code extension, ACP) |
| `module/db` | `supabase/` migrations |

Feature-area branches (also from `main`, 2026-10-18) — pick the one that owns the thing you're changing:

| branch | owns |
|---|---|
| `module/usage-meter` | all token counting / allowance: `services/quota/`, `tokenUsage.ts`, `usageService.ts`, migrations' `quota_*` functions, Console → Usage ledger / Credits / Model multipliers |
| `module/billing-plans` | `billing/`, `billingService.ts`, plan catalog + entitlements, packages/offers, `services/finance/`, `/upgrade` page, Console → Plans / Billing / Finance |
| `module/admin-console` | Team Console: `services/console/`, `routes/admin.tsx`, `frontend/src/console/` (Users, Team, Support, CRM, Tasks, Updates, Marketing, Audit) |
| `module/build-mode` | `services/projectBuild/`, `e2bService.ts`, `services/browser/`, `services/jobs/`, Build workspace + `BuildCanvas` UI |
| `module/plugins` | connectors + MCP: `connectorService.ts`, `tokenConnectors.ts`, `googleAuth.ts`, `githubAuth.ts`, `agent/mcp*`, `tools/connectors.ts`, `plugins-drawer.tsx` |
| `module/skills` | `services/skills/`, `tools/skills.ts`, `skills-panel.tsx` |
| `module/memory` | `memoryService.ts`, `services/knowledge/` (project files, embeddings), `tools/memory.ts`, `tools/projectSearch.ts`, Settings → Memory |
| `module/chat` | `services/chat/`, `services/providers/` (adapters, prompt cache), `modelRouting.ts`, chat UI (`message-thread.tsx`, `lib/chat/`) |
| `module/agent-tools` | `services/agent/` tool loop + `tools/` (web, code, research, image, github, google) |
| `module/documents-pages` | `services/documents/` (pptx/xlsx/docx/pdf generation), `services/pages/`, `/api/files`, Pages UI |
| `module/library` | `libraryService.ts`, `attachmentStorage.ts`, `routes/library.tsx` (sections, previews, storage meter) |
| `module/automations` | `services/automations/` (schedules, scheduler) + `routes/automations.tsx` page |
| `module/status` | `services/status/`, `/status` page, crash + problem reports |
| `module/auth-accounts` | `routes/auth`, `services/sessions/`, `policyService.ts`, `organizationService.ts`, profile/consent gates |
| `module/mail` | `services/mail/`, `emailService.ts`, Mailbox / Mail hosting |
| `module/voice` | `voiceService.ts`, voice UI |

FridayX CLI and IDE are `module/cli` and `module/ide` above. If a change spans two areas, use the area that owns
most of it and mention the other in the PR; if it spans many, use a task branch off `main`.

They are named `module/…` (not bare `backend`) because `git checkout backend` would be ambiguous with the folder.

How to use them:
- A developer owning a module works on its branch (or on a task branch cut from it) and opens a PR
  `module/<x>` → `main` when a piece of work is done.
- **Sync is automatic:** `.github/workflows/sync-module-branches.yml` merges `main` into every `module/*`
  branch after each push to main. A branch that conflicts is skipped and gets an issue
  "Merge conflict: main → module/<x>" — then merge by hand:
  `git checkout module/backend && git pull && git merge origin/main && git push`.
  Always `git pull` before starting work on a module branch (the bot may have pushed).
  A module branch that isn't synced drifts, and the merge back gets big and risky — that is exactly
  what went wrong with v1/v2/v3.
- A change that touches several modules (e.g. a new API + its web screen + migration) goes on one task
  branch off `main`, not split across module branches, so it merges as one working unit.

## Branch names

```
<type>/<area>-<short-what>
```

| type | use for |
|---|---|
| `feature/` | new behaviour |
| `fix/` | a bug |
| `chore/` | tooling, deps, CI, cleanup |
| `docs/` | docs only |
| `hotfix/` | urgent production fix (same flow, reviewed fast) |

Areas match the code: `usage-meter` (quota/billing), `chat`, `agent`, `build`, `console`, `finance`,
`mail`, `pages`, `skills`, `status`, `fridayx` (cli/ + ide/), `android`, `ios`, `web` (frontend-only),
`infra`, `db` (migrations only).

Examples: `feature/usage-meter-rollover`, `fix/build-preview-blank`, `chore/ci-cache-node`.

## The flow

```bash
git checkout main && git pull                     # always start from the latest main
git checkout -b feature/usage-meter-rollover      # one branch per task
# … work, commit small steps (what + why) …
npm run verify                                    # same checks as CI
git push -u origin feature/usage-meter-rollover
gh pr create --base main                          # PR → review → CI green → merge
```

After the merge: delete the branch (GitHub's "Delete branch" button or `git push origin --delete <branch>`),
then `git checkout main && git pull`.

Rules:
- A branch lives **days, not weeks**. If it lasts longer, merge `main` into it at least every couple of days.
- One task per branch. A second, unrelated change gets its own branch.
- Squash or merge commits are both fine; the PR title says what + why.
- Migrations: only one open PR adds a migration number at a time; the second rebases and renumbers
  (`npm run verify:migrations` catches clashes). Applying them on prod stays a manual step.
- Big features ship behind a kill switch / entitlement so they can merge early, switched off.

## Releases

Production is whatever is on `main`. Rollback = redeploy an earlier `main` commit (EC2_DEPLOY.md).
Mark notable releases with an annotated tag: `git tag -a v4 -m "…" && git push origin refs/tags/v4`.
FridayX keeps its own `friday-x-v*` / `ide-v*` tags, which trigger their release workflows.

## Protecting main

Branch protection (require PR + passing CI, no direct pushes) needs GitHub Pro/Team for a private repo.
Until that is enabled, it is a team rule: **never push directly to `main`**.
