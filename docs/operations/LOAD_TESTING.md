# Load testing (staging only)

`scripts/load/load-test.mjs` ramps simulated users in stages (default 10 → 50 → 100 → 250, 30 s each)
and reports requests, errors, requests/s and p50/p95/p99 latency per stage. It **refuses the
production host** and stops climbing once a stage passes 5 % errors.

## Before you run it

1. A staging stack (its own Supabase + backend), never production — brief §30.
2. Synthetic test accounts; put their access tokens in `FRIDAY_LOAD_TOKENS` (comma-separated, reused round-robin).
3. Decide whether to include chat. Without `--chat` the workload is provider-free
   (`/api/health`, `/api/usage/quota`, `/api/notifications`). `--chat` sends real model turns
   (~20 % of requests) and **costs provider money and tokens** — it requires `--max-chat-requests N`.

```bash
FRIDAY_LOAD_URL=https://friday-test.example.com FRIDAY_LOAD_TOKENS=tok1,tok2 node scripts/load/load-test.mjs
FRIDAY_LOAD_URL=… FRIDAY_LOAD_TOKENS=… node scripts/load/load-test.mjs --stages 10,50 --seconds 60 --chat --max-chat-requests 100
```

## Reading the results

- **p95 / p99** — what slow users feel; compare stages, not absolute numbers on a laptop.
- **ttfbP95** (chat only) — time to the first streamed byte; this is "is Friday thinking or stuck?".
- Watch the box while it runs: `docker stats`, Postgres connections (`select count(*) from pg_stat_activity`),
  `quota_reserve_failed` in the logs (the ledger fails closed under DB pressure — by design).

Record each run (date, commit, stage table, box size) in the release notes. These stages are tests,
not a capacity promise.

**Status (2026-10-17):** harness ready; not yet run — no staging environment exists.
