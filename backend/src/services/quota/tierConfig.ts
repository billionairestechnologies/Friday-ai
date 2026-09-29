export type Plan = "free" | "pro" | "premium";

export type PlanLimits = {
  /** Hard ceiling per calendar week (resets Monday 00:00 UTC — see weekResetAt). */
  weeklyTokens: number;
  /** Sliding 5-hour window ceiling, enforced via a Redis sorted set. */
  rollingWindowTokens: number;
  rollingWindowSeconds: number;
  /** Soft backstop on top of the weekly cap — null means "no separate monthly ceiling" (free). */
  monthlyTokens: number | null;
};

export const ROLLING_WINDOW_SECONDS = 5 * 60 * 60; // 18,000s
export const WEEKLY_TTL_SECONDS = 7 * 24 * 60 * 60; // 604,800s

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    weeklyTokens: 250_000,
    rollingWindowTokens: 50_000,
    rollingWindowSeconds: ROLLING_WINDOW_SECONDS,
    monthlyTokens: null,
  },
  pro: {
    weeklyTokens: 2_500_000,
    rollingWindowTokens: 500_000,
    rollingWindowSeconds: ROLLING_WINDOW_SECONDS,
    monthlyTokens: 10_000_000,
  },
  premium: {
    weeklyTokens: 6_250_000,
    rollingWindowTokens: 1_200_000,
    rollingWindowSeconds: ROLLING_WINDOW_SECONDS,
    monthlyTokens: 25_000_000,
  },
};

/** Enterprise seats each add this many pooled tokens/month to their org (no per-seat rolling window). */
export const ENTERPRISE_TOKENS_PER_SEAT = 35_000_000;
export const ENTERPRISE_MIN_SEATS = 3;

const PLAN_RANK: Record<Plan, number> = { free: 0, pro: 1, premium: 2 };

/** Whether `plan` (or an enterprise member, who can reach anything) satisfies a model's min_tier. */
export function planSatisfiesTier(plan: Plan, minTier: Plan): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[minTier];
}

export type QuotaCounters = {
  rollingTokens: number;
  weeklyTokens: number;
  monthlyTokens: number;
};

export type QuotaDecisionInput = {
  plan: Plan;
  reserveTokens: number;
  counters: QuotaCounters;
  /** Effective individual limits (personal monthly cap applied) — see effectiveIndividualLimits. */
  limitsOverride?: { rolling: number; weekly: number; monthly: number | null };
  /** Present only for an enterprise org member — bypasses the plan table entirely. */
  enterprise?: {
    pooledMonthlyTokens: number;
    orgMonthlyUsedTokens: number;
    /** Optional per-member sub-cap an org admin set — checked in addition to the shared pool. */
    memberMonthlyCap?: number | null;
    memberMonthlyUsedTokens?: number;
  };
};

export type QuotaDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "rolling_window" | "weekly" | "monthly" | "org_pool" | "member_cap";
      limit: number;
      used: number;
    };

/**
 * Pure decision function — given current counter values and a plan (or enterprise override),
 * decides whether `reserveTokens` more can be spent right now. No I/O: the Redis/Postgres reads
 * that produce `counters`/`enterprise` live in tokenQuotaService.ts, which is what actually needs
 * a live Redis/DB connection to test; this function is what's unit-tested directly.
 *
 * Enterprise members skip the 5-hour rolling window entirely (spec: "bypass 5-hour rolling
 * lockouts completely") and are checked against the org's shared monthly pool instead of the
 * individual plan table, plus an optional per-member sub-cap the org admin configured.
 */
export function decideQuota(input: QuotaDecisionInput): QuotaDecision {
  const { reserveTokens, counters, enterprise } = input;

  if (enterprise) {
    if (
      enterprise.memberMonthlyCap != null &&
      (enterprise.memberMonthlyUsedTokens ?? 0) + reserveTokens > enterprise.memberMonthlyCap
    ) {
      return {
        allowed: false,
        reason: "member_cap",
        limit: enterprise.memberMonthlyCap,
        used: enterprise.memberMonthlyUsedTokens ?? 0,
      };
    }
    if (enterprise.orgMonthlyUsedTokens + reserveTokens > enterprise.pooledMonthlyTokens) {
      return {
        allowed: false,
        reason: "org_pool",
        limit: enterprise.pooledMonthlyTokens,
        used: enterprise.orgMonthlyUsedTokens,
      };
    }
    return { allowed: true };
  }

  const base = PLAN_LIMITS[input.plan];
  const limits = input.limitsOverride ?? { rolling: base.rollingWindowTokens, weekly: base.weeklyTokens, monthly: base.monthlyTokens };

  if (counters.rollingTokens + reserveTokens > limits.rolling) {
    return { allowed: false, reason: "rolling_window", limit: limits.rolling, used: counters.rollingTokens };
  }
  if (counters.weeklyTokens + reserveTokens > limits.weekly) {
    return { allowed: false, reason: "weekly", limit: limits.weekly, used: counters.weeklyTokens };
  }
  if (limits.monthly != null && counters.monthlyTokens + reserveTokens > limits.monthly) {
    return { allowed: false, reason: "monthly", limit: limits.monthly, used: counters.monthlyTokens };
  }
  return { allowed: true };
}

/** Next Monday 00:00 UTC strictly after `from` — the weekly reset boundary shown in the UI. */
export function nextWeeklyReset(from = new Date()): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const daysUntilMonday = (8 - d.getUTCDay()) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d;
}

/** First of next UTC month — the monthly reset boundary shown in the UI. */
export function nextMonthlyReset(from = new Date()): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
}

/** End of the current 5-hour rolling window given the oldest still-counted reservation's timestamp. */
export function rollingWindowResetAt(oldestReservationMs: number | null, from = new Date()): Date {
  if (oldestReservationMs == null) return from;
  return new Date(oldestReservationMs + ROLLING_WINDOW_SECONDS * 1000);
}
