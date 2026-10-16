import { normalizeUsage, type TokenUsage } from "../tokenUsage.js";

/**
 * The token-accounting policy, in one place. Everything that charges, displays or audits usage
 * goes through these functions — there is no other counter.
 *
 * BILLABLE TOKENS (what the monthly allowance pays for), per model invocation:
 *
 *   billable = fresh input + cache-write input + output + ⌈10% × cache-read input⌉
 *
 * where fresh input = prompt − cache reads − cache writes. Output already includes reasoning/
 * thinking tokens for every provider (normalized in tokenUsage.ts), so reasoning is never added
 * again, and the provider's own `total` is never added to its parts. Cache reads count at a tenth
 * because an agent turn re-reads its whole transcript every round: one Build turn reads ~1.2M
 * prompt tokens, ~90% from cache, at a tenth of the price (owner decision, 2026-10-17).
 *
 * Raw input / output / cached / reasoning counts are stored on every ledger row next to the
 * billable figure, so the rule can be audited or re-run.
 */
export const CACHE_READ_WEIGHT = 0.1;
export const METER_VERSION = "billable-v1";

export function billableTokens(raw: TokenUsage): number {
  const u = normalizeUsage(raw);
  const cached = u.cachedTokens ?? 0;
  const fresh = u.promptTokens - cached; // includes cache writes, billed as normal input
  return fresh + u.completionTokens + Math.ceil(cached * CACHE_READ_WEIGHT);
}

/**
 * The balance rule (mirrors quota_account_snapshot in supabase 0057):
 *   remaining = allowance − used − adjustments − reserved
 * `used` is Σ ledger billable tokens this period; `adjustments` is Σ admin corrections/bonuses
 * (negative = tokens given back); `reserved` is the holds of requests still running.
 */
export type QuotaSnapshot = {
  accountId: string;
  plan: string;
  allowance: number;
  used: number;
  adjustments: number;
  reserved: number;
  remaining: number;
  periodStart: string;
  periodEnd: string;
  status: "active" | "suspended";
};

export function remainingOf(s: Pick<QuotaSnapshot, "allowance" | "used" | "adjustments" | "reserved">): number {
  return s.allowance - s.used - s.adjustments - s.reserved;
}

/** Percent of the allowance consumed (finalized usage + adjustments), clamped 0–100 for display. */
export function percentUsed(s: Pick<QuotaSnapshot, "allowance" | "used" | "adjustments">): number {
  if (s.allowance <= 0) return 100;
  return Math.max(0, Math.min(100, Math.floor(((s.used + s.adjustments) / s.allowance) * 100)));
}

/** Snake-case JSON from the SQL functions → QuotaSnapshot. Every number is validated. */
export function snapshotFromRow(row: Record<string, unknown>): QuotaSnapshot {
  const n = (v: unknown) => {
    const x = typeof v === "string" ? Number(v) : (v as number);
    return Number.isFinite(x) ? Math.trunc(x) : 0;
  };
  return {
    accountId: String(row.account_id ?? ""),
    plan: String(row.plan ?? "free"),
    allowance: n(row.allowance),
    used: n(row.used),
    adjustments: n(row.adjustments),
    reserved: n(row.reserved),
    remaining: n(row.remaining),
    periodStart: new Date(String(row.period_start)).toISOString(),
    periodEnd: new Date(String(row.period_end)).toISOString(),
    status: row.status === "suspended" ? "suspended" : "active",
  };
}

// ── Periods (TypeScript mirror of quota_add_months / quota_period_index — the SQL is authoritative;
//    test/quotaLedger.db.test.ts checks the two agree) ─────────────────────────────────────────────

/** anchor + n calendar months in UTC, clamped at month end (Jan 31 + 1 → Feb 28/29; + 2 → Mar 31). */
export function addMonthsUtc(anchor: Date, n: number): Date {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + n;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/** The period containing `now` for a subscription anchored at `anchor`. */
export function periodFor(anchor: Date, now: Date): { index: number; start: Date; end: Date } {
  if (now < anchor) return { index: 0, start: anchor, end: addMonthsUtc(anchor, 1) };
  let n = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  while (n > 0 && addMonthsUtc(anchor, n) > now) n--;
  while (addMonthsUtc(anchor, n + 1) <= now) n++;
  return { index: n, start: addMonthsUtc(anchor, n), end: addMonthsUtc(anchor, n + 1) };
}

// ── Why a request was refused ────────────────────────────────────────────────

/**
 * Kept distinct on purpose: a provider outage or rate limit must never read as "you're out of
 * tokens", and "we couldn't reach the usage ledger" must never read as either.
 */
export type QuotaBlockReason = "exhausted" | "member_cap" | "suspended" | "unavailable";

export const QUOTA_REASON_TEXT: Record<QuotaBlockReason, string> = {
  exhausted: "You've used all of this month's tokens",
  member_cap: "You've reached the monthly token cap your organization admin set",
  suspended: "Usage on this account is paused — please contact support",
  unavailable: "We couldn't check your usage balance right now — please try again in a minute",
};

/** Shown when a running turn is stopped by the balance. */
export const QUOTA_STOP_MESSAGE: Record<QuotaBlockReason, string> = {
  exhausted: "You've used all of this month's tokens, so I stopped here.",
  member_cap: "You've reached the monthly cap your admin set, so I stopped here.",
  suspended: "Usage on this account is paused, so I stopped here.",
  unavailable: "I couldn't record usage right now, so I stopped here to be safe. Please try again in a minute.",
};

/** HTTP status for a refused request: 429 for the customer's own limits, 403 suspended, 503 when the ledger is down. */
export function httpStatusFor(reason: QuotaBlockReason): number {
  return reason === "unavailable" ? 503 : reason === "suspended" ? 403 : 429;
}

/** Thresholds (percent of the allowance) at which a usage notice is sent once per period. */
export const USAGE_NOTICE_THRESHOLDS = [80, 95, 100] as const;
