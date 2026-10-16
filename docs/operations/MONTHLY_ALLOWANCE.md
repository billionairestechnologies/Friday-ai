# Monthly token allowance and usage ledger

Status: built on branch `feature/monthly-token-allowance` (migration `0057`). **Not deployed.**
This is the policy, the design, and the runbook for metering and enforcing usage.

## 1. Policy

| Plan | Price | Allowance per subscription month |
|---|---|---|
| Free | ₹0 | 1,000,000 tokens |
| Pro | ₹999 | 10,000,000 tokens |
| Premium | ₹1,999 | 25,000,000 tokens |
| Enterprise | ₹2,499 / seat | 30,000,000 tokens per seat, pooled across the org |

- **One allowance per customer per period.** Every model, feature and surface draws on it: chat, Deep Research, Team Up, Build, automations, the FridayX CLI/IDE and sandbox auto-fix.
- **Nothing else resets it.** Switching models, new chats, new devices or new CLI tokens all draw on the same balance.
- **No 5-hour, daily or weekly caps.** A customer may spend the whole month on day one.
- **Monthly periods follow the subscription date.** A period runs from `anchor + n months` to `anchor + n+1 months` in UTC, clamped at month end. A plan started 31 Jan renews 28/29 Feb, then 31 Mar, then 30 Apr. A plan started on the 17th renews on every 17th.
- **Exhausted means blocked server-side.** Requests are refused until the next period starts, an upgrade, or an admin adjustment.
- Allowances are integers in the console-edited plan catalog (Console → Plans → Edit). The code defaults are in `backend/src/services/quota/tierConfig.ts`. A personal cap (`profiles.custom_monthly_cap`, set by a package, grant or admin) replaces the plan figure for that person.

### What counts as a token (the billable-token rule)

For each model call:

```
billable = fresh input + cache-write input + output + ⌈10% × cache-read input⌉
fresh input = prompt − cache reads − cache writes
```

- **Output already includes reasoning/thinking for every provider.** OpenAI's `completion_tokens` and Anthropic's `output_tokens` include it. Gemini reports `thoughtsTokenCount` separately; the normalizer adds it to output exactly once. Before this change, Gemini thinking was never metered at all.
- **A provider's own `total` is never added to its parts.** Cached and cache-write tokens are a breakdown *of* the prompt and are never counted twice.
- **Cache reads count at 10% (owner decision, 2026-10-17).** One Build turn re-reads its transcript every round: about 1.2M prompt tokens, about 90% from cache.
- Raw input / output / cached / cache-write / reasoning counts are stored on every ledger row next to the billable figure, so the rule can be audited or re-run. Code: `quota/allowance.ts#billableTokens`; normalizers: `tokenUsage.ts`.

### Subscription lifecycle

Payments are one-time Razorpay orders: 30 days for monthly, 365 days for annual. There is no auto-renew. Every rule below runs in an idempotent SQL function keyed on the order, so a duplicate or retried webhook changes nothing.

| Event | What happens |
|---|---|
| First purchase (from Free) | New term starts now; fresh period with the full allowance. |
| Same plan again, still running (renewal) | Term extended from its current end. The running period is **not** reset; the next period starts on its normal date. |
| Upgrade (Pro → Premium) | New term starts now; fresh period with the new allowance. Remaining Pro days are not carried over, same as before. |
| Cheaper plan while a pricier one runs (downgrade) | Queued: it starts when the current term ends, with the period anchored at that moment. |
| Term ends, nothing queued (expiry) | The account drops to Free at the end instant, not at the next request. |
| Payment failed | The order is marked failed (never a paid order); a `payment_failed` event is logged. Nothing is taken away. |
| Refund (`refund.processed` / `payment.refunded`) | The refunded order's days come off the term. If that ends it, the account is on Free from now. Tokens already used are not reversed. |
| Cancellation | There is no auto-renew, so the plan simply runs to the end of the paid term. |
| Annual plan | 12 monthly allowances, each renewing on the purchase date. |
| Enterprise payment | Seats set; pool = seats × per-seat allowance; the org starts a fresh period. |
| Admin plan change / package / grant | The new allowance applies to the current period immediately. Usage so far stays counted. |

Admins can suspend an account. Suspension blocks every new billable request and leaves history untouched.

## 2. Architecture

### Before

- **Unit:** credits (cost: 100,000 = US$1).
- **Windows:** a sliding 5-hour window, a calendar week (Monday UTC) and a calendar month (the 1st, UTC).
- **Authority:** Redis counters (`quota:v2:*`), failing **open**. If Redis was down, usage was unlimited.
- **Ledger:** `token_ledger` was an audit table written fire-and-forget, one row per turn.
- **Unmetered paths:** hedge losers, a winner that broke off mid-reply (fully refunded), routing probes, and `/api/sandbox/run` auto-fix, which made up to 25 model calls with no metering.

### After

```
request ─► quotaLimit / checkAndReserve ─► quota_reserve (row lock) ─► hold
          │ refused: 429 exhausted / member_cap · 403 suspended · 503 unavailable
          ▼
       UsageMeter (per turn, AsyncLocalStorage)
          ├─ ensureHold(real prompt × fan-out)          ─► quota_extend_hold
          ├─ each model call / agent round              ─► quota_record_usage (1 ledger row, idempotency key)
          │     returns ok=false at 0 remaining → the loop stops before the next call
          └─ turn ends (any path)                       ─► quota_settle (hold released)
background (every 10 min): stale holds · lapsed terms · quota_audit · alerts
```

- **Postgres is the only authority.** Every balance change is a plpgsql function that locks the account row (`SELECT … FOR UPDATE`; lock order profile → account → reservation → member row). That makes reservations atomic across any number of API instances. Redis now only de-duplicates alert emails.
- **Fail closed.** If the ledger can't be reached, a new request gets HTTP 503 `quota_unavailable`, and a running turn stops at its next model call with "I couldn't record usage…". Unwritten rows are retried with the same key. If they still can't be written they are logged in full (`quota_usage_unrecorded`), never dropped.
- **Distinct refusal reasons:** `exhausted`, `member_cap`, `suspended`, `unavailable`. Provider outages and rate limits keep their own friendly errors (`utils/providerError.ts`) and are never shown as quota.

### Tables (migration 0057)

| Table | Role |
|---|---|
| `quota_accounts` | One per user or enterprise org: plan, allowance, `period_anchor/start/end`, `used`, `adjustments`, `reserved`, status, queued downgrade, notice threshold. |
| `quota_reservations` | Holds: `hold`, `consumed`, status (`active/settled/expired/failed`), heartbeat. |
| `token_ledger` (extended) | One row per metered model invocation. New columns: `account_id`, `reservation_id`, `period_start`, **unique** `idempotency_key`, `billable_tokens`, `reasoning_tokens`, `overrun_tokens`, `usage_source` (`provider/estimated/none`), `call_status` (`ok/partial/failed/aborted`), `conversation_id`, `request_id`, `attempt`, `streaming`, `latency_ms`, `meter_version`. Cost columns (`cost_usd`, `sell_inr`) as before. |
| `quota_adjustments` | Append-only bonus / reset / refund / correction / debit, unique key. |
| `quota_member_usage` | Per-member usage inside an enterprise pool, for admin-set member caps. |
| `subscription_events` | Idempotent lifecycle log: payment, renewal, upgrade, queued/applied downgrade, expiry, refund, payment_failed, suspension. |

**The balance rule** (the only one, used everywhere):

```
used        = Σ token_ledger.billable_tokens   (account, current period)
adjustments = Σ quota_adjustments.tokens       (account, current period; negative = given back)
remaining   = allowance − used − adjustments − reserved
```

The stored figures are maintained in the same transaction as each insert. `quota_audit()` recomputes all of them from the logs and lists any account that disagrees. It runs every 10 minutes, alerts the team, and is shown in Console → Usage ledger.

### Reservation, settlement and locking

1. **Pre-flight.** The route middleware holds message + attachments + an 800-token output buffer. FridayX holds the prompt plus its own `max_tokens`. The request is refused if `amount > remaining`, so the exact last token can be spent but not one more.
2. **Real prompt.** Once the turn has built the history, the hold grows to the full prompt × the number of models it fans out to (Team Up). It is refused before any model is paid for if the balance can't cover it.
3. **Every model call writes a row.** Recording releases the hold up to the amount used. Agent loops report running totals; only the new part since the last report becomes a row, so a final reconcile can't double-count.
4. **Before each further agent round,** the hold grows by the size of the round just finished. Two concurrent turns therefore can't both spend the last tokens.
5. **Overrun.** A call can still use more than its hold: the provider decides output length, and the call has already happened. Its usage is recorded in full, `overrun_tokens` is set on the row, and the turn stops. Policy: the overrun is absorbed (remaining shows 0); it is not carried into the next period as debt.
6. **Settle.** At the end of every turn, however it ends, the remaining hold is released (idempotent).
7. **Stale holds.** A hold whose request stopped reporting for 2 hours (a crashed server) is expired by the background job. Live requests heartbeat on every model round and no turn runs past about 60 minutes of work, so a live request is never released. A Build waiting for the user's approval past 2 hours loses only its *hold*; its usage is still recorded exactly when it resumes.

### What is metered, and what is charged

| Call | Ledger row | Charged to the allowance |
|---|---|---|
| Chat / Deep Research / tool-loop rounds, Build rounds, Team Up proposers + synthesizer, FridayX, automations, sandbox auto-fix | yes | yes |
| Hedged stream: the winner (complete, partial or stopped by the user) | yes | yes |
| Hedged stream: the loser we aborted for latency | yes (estimated, `aborted`) | no — our latency optimisation, not the customer's |
| Failed attempt before any output (HTTP error) | yes (0 tokens, `failed`) | no — not billed upstream |
| Clarify questions (chat + Build) | yes (estimated) | yes — they are the reply |
| Search / Build intent probes | yes (estimated) | no — routing overhead |
| Build visual review + transcript summary | inside the Build total (estimated) | yes |
| Embeddings for project knowledge, image generation | no (images have their own daily allowance) | no |

**Estimates.** Usage is estimated at about 4 characters per token, only where the provider returned none: non-streaming `adapter.chat()` helpers, a stream cut off before its final usage event, and the rare provider that never reports usage. Every estimated row is flagged `usage_source = estimated` and labelled "≈" in the customer dashboard. The team is alerted if more than 20% of charged calls in an hour were estimated. The supplier exposes no per-request usage API, so these rows cannot be reconciled later against an upstream record. That limitation is stated, not hidden.

## 3. Migration and rollback

`0057` runs once (marker: `meter_unit.unit = 'billable_tokens'`) and is safe to run twice.

Owner's decision: **every paid customer gets a fresh period from deploy.**

- Each paid individual and each enterprise org gets an account with `anchor = migration time`, `used = 0`.
- Paid terms ending within 30 days are extended to `deploy + 30 days`. Longer (annual) terms are kept.
- Free users get their account on their first request after deploy (`anchor` = that moment).
- Plan catalog: `monthly_tokens` = 1M / 10M / 25M; `tokens_per_seat` = 30M; the weekly and 5-hour columns are set to null (retired). The default feature bullets are rewritten; custom wording is left alone.
- Personal caps, package caps and custom org pools were stored in credits. They are converted relative to the plan they were sized against, so "2× Pro" stays 2× Pro:
  - individual caps × (10M ÷ Pro's old 450,000-credit month);
  - pools × 30.
  - Pools that were just seats × the old default become "seats × catalog per-seat".
  - **Review these rows in Console → Plans after deploying.**
- Historic `token_ledger` rows are kept as they are (`account_id` null). They never count against a new period.
- The old Redis `quota:v2:*` keys are no longer read and expire on their own (45 days at most).

### Before deploying: back up and rehearse

```sql
-- On the production DB, before 0057 (keep the file):
\copy (select id, plan, plan_renews_at, custom_monthly_cap from profiles) to 'profiles_pre_0057.csv' csv header
\copy (select id, plan, seat_count, pooled_monthly_tokens from organizations) to 'orgs_pre_0057.csv' csv header
\copy (select * from plan_catalog) to 'plan_catalog_pre_0057.csv' csv header
\copy (select id, monthly_token_cap, pooled_monthly_tokens from plan_packages) to 'packages_pre_0057.csv' csv header
\copy (select id, monthly_token_cap, pooled_monthly_tokens from access_grants) to 'grants_pre_0057.csv' csv header
```

Rehearse on a staging copy first. Restore a `pg_dump` of production into a scratch database, apply 0057, and spot-check `quota_accounts`, the converted caps and `select * from quota_audit()` (it should return no rows).

### Deploy order (EC2: see EC2_DEPLOY.md)

1. Back up (above).
2. Apply `supabase/migrations/0057_monthly_token_allowance.sql`. The current server keeps working: the new columns are nullable and its catalog fallbacks still apply. Between steps 2 and 3, converted personal caps are briefly read as credits by the old server, which is more generous, never stricter.
3. Deploy the new image. No new environment variables are required.
4. Smoke test as a Free test account:
   - Send a chat and check Settings → Usage moves.
   - In Console → Usage ledger, check the account, its rows and "Reconcile now" (no discrepancies).
   - Run one Build turn and one FridayX request.
5. In Console → Plans, review converted package caps; edit plan bullets if you customised them.
6. Mobile: the apps already read the new payload. The new "This month" labels reach users with the next store builds.

### Rollback

- **Code:** redeploy the previous image. It still works against the 0057 schema: it ignores the new tables and columns and falls back to its code defaults for the nulled window columns.
- **Data:** if the old metering must be fully restored:
  1. Restore `plan_catalog`, `custom_monthly_cap`, `pooled_monthly_tokens` and the package/grant caps from the CSVs above.
  2. Set `meter_unit.unit = 'credits'`.

  Leave the new tables in place; they are inert for the old code. The `plan_renews_at` extensions are deliberately not reverted (customers keep the extra days).

## 4. Configuration

| Variable | Meaning |
|---|---|
| `FRIDAY_DISABLE_QUOTA_JOBS=1` | Turns off the 10-minute maintenance job (stale holds, expiries, audit, alerts). Enforcement is unaffected. |

Retired: the Redis quota counters. `REDIS_URL` is still used for rate limits, daily feature allowances and alert de-duplication. `FRIDAY_PROMPT_CACHE`, the Finance blended rate and every other setting are unchanged.

## 5. Dashboards and alerts

- **Customer (Settings → Usage, web; "This month" on Android/iOS):**
  - plan, "2.45M / 10M tokens", percent, remaining, tokens held for running requests;
  - period dates, renewal or paid-through date, expired/queued notices;
  - notices at 80 / 95 / 100%, with the renewal date at 100%;
  - breakdown by model (with vendor), feature and recent calls; input / output / cached / thinking totals; estimated amounts; adjustments.

  One shared store feeds the Usage panel, Billing, toasts and the plan badge, so they can't disagree. It refreshes after every turn, on focus and every 30 s while the panel is open. Push notifications fire once per threshold per period.
- **Team Console → Usage ledger:**
  - every account's balance (filters: 80%+, out of tokens, suspended); held tokens and stuck holds;
  - reconciliation discrepancies; failed/partial calls; estimated calls;
  - plan events (failed payments, renewals, upgrades, expiries, refunds);
  - per-account detail: by model, reservations, adjustments, recent calls, events;
  - append-only adjustments (bonus / refund / debit / correction, with a reason); suspend / restore; CSV export of the raw ledger; "Reconcile now".

  Profit per plan stays in Console → Plans → Profit, now in tokens.
- **Alerts** (email to the team, 6-hour cooldown each):
  - ledger discrepancy;
  - an account more than 5% past its allowance (possible bypass);
  - an account using more than 25% of its month in one hour;
  - more than 20% of charged calls in an hour estimated (missing provider usage).

## 6. Tests

`npm --prefix backend test`: 240 pass, 0 fail. The Postgres suite skips without a database.

| Suite | Covers |
|---|---|
| `allowance.test.ts` | Input/output/total counting, no double count of provider total, cached and reasoning, each provider format, malformed fields, running-total deltas, balance rule, month-end and leap-year periods, period boundaries. |
| `usageMeter.test.ts` | Hold → record → settle, per-round rows adding up exactly once, a retry after a lost response (same key), model switching on one allowance, stopping before an unaffordable round, overrun recorded in full, ledger outage failing closed and recovering, metered helper calls (charged vs not), concurrent records never skipping or duplicating. |
| `latency.test.ts` | Hedged attempts reported: the loser as aborted, failover as failed. |
| `quotaLedger.db.test.ts` (real Postgres, 20 tests) | Migration applied twice; SQL period math equals TypeScript across month ends and leap years; exact last token; request larger than what's left; **60 concurrent reservations on 16 connections → exactly 20 succeed**; 30 racing for the last tokens → exactly 1; duplicate usage callbacks and settlements; replayed reservation id; overrun; one notice per threshold; rollover on the anchor date; no daily cap (10M in one day); full lifecycle (subscribe, duplicate + concurrent duplicate webhooks, renewal, upgrade, queued downgrade, expiry); annual plan; refunds; idempotent adjustments; suspension; stale vs live holds; enterprise pool with a member cap; the service layer on real SQL with two devices sharing one balance; reconciliation report. |

To run the Postgres suite locally (Postgres 17 from Homebrew):

```bash
initdb -D /tmp/pgq -U postgres -A trust
pg_ctl -D /tmp/pgq -o "-p 54329 -c listen_addresses=127.0.0.1" start
QUOTA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm --prefix backend test
```

### Reconciliation report (known requests, real SQL)

| Request | input | output | cached | reasoning | billable |
|---|---:|---:|---:|---:|---:|
| OpenAI plain | 1,200 | 300 | 0 | 0 | **1,500** |
| OpenAI cached + reasoning | 20,000 | 2,000 | 18,000 | 1,500 | **5,800** |
| Anthropic cache read + write | 50,100 | 800 | 45,000 | 0 | **10,400** |
| Gemini with thinking | 3,000 | 3,000 | 1,000 | 2,600 | **5,100** |
| No usage reported (estimated) | 1,000 | 250 | 0 | 0 | **1,250** |
| **Expected** | | | | | **24,050** |

The ledger held 24,050 billable tokens in 5 rows, 1,250 of them estimated. `account.used` was 24,050, `reserved` was 0, and `quota_audit()` returned no rows.

## 7. LiteLLM: evaluated, not adopted

Friday's backend already is the gateway. Every model call goes through its own provider adapters (`services/providers/*`), which hold the keys server-side and now normalize each vendor's usage report (including stream-final usage with `stream_options.include_usage`).

Putting LiteLLM Proxy in front would add another service, its own Postgres and another network hop on the single production box. Its spend budgets are monetary, so they still couldn't enforce token allowances: the dedicated ledger above would be needed anyway. And the main upstream supplier is a reseller with OpenAI/Anthropic-compatible endpoints that gives no per-request usage records either way, so LiteLLM would not add a reconciliation source.

Revisit if Friday moves to multiple upstream accounts per vendor or needs cross-provider load balancing. The ledger's `provider_slug` / `model_id` / `request_id` columns are ready to be matched against gateway logs.

## 8. Known limitations and unfinished items

- **Supplier usage can't be cross-checked per request.** We record what each response reports. There is no upstream per-request record to reconcile against, so estimated rows stay estimates. The 20% alert watches for drift.
- **Cost accuracy depends on the supplier's cache billing.** If the supplier bills cache reads at the full rate, real cost per billable token is higher than the plan economics assume. Finance → Live usage shows measured cost.
- **No hard output cap on chat/Build calls.** No `max_tokens` is forced there (it would truncate answers). Overruns are bounded by the per-round hold and stop the turn. FridayX does forward the client's `max_tokens`.
- **Small attribution gap.** A tool-loop round that fails over to another model *within the same round* is attributed to the model that answered. The failed first attempt (no output) is not a separate row there.
- **Enterprise terms have no expiry date.** Enterprise is invoiced and handled manually, so the org pool renews monthly until an admin changes the plan.
- **Not done here:**
  - deploying;
  - running one real Build turn against production to compare the ledger with the supplier's dashboard;
  - new mobile store builds;
  - a visual check of the new web panels in a browser (Playwright isn't installed on this Mac).
