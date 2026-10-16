export type Plan = "free" | "pro" | "premium";

/**
 * Monthly allowance per plan, in BILLABLE TOKENS (see allowance.ts#billableTokens), for one
 * subscription period. There are no 5-hour, daily or weekly windows: a customer may spend the whole
 * allowance on day one, and it renews only when their next period starts (supabase 0057).
 *
 * These are the code defaults; the console-edited plan catalog (plan_catalog.monthly_tokens /
 * tokens_per_seat) overrides them, and a personal cap (profiles.custom_monthly_cap, set by a
 * package, grant or admin) replaces the plan figure for that one person.
 */
export const PLAN_ALLOWANCES: Record<Plan, number> = {
  free: 1_000_000,
  pro: 10_000_000, // ₹999
  premium: 25_000_000, // ₹1,999
};

/** Enterprise seats each add this many pooled tokens per period to their org. */
export const ENTERPRISE_TOKENS_PER_SEAT = 30_000_000;
export const ENTERPRISE_MIN_SEATS = 3;

const PLAN_RANK: Record<Plan, number> = { free: 0, pro: 1, premium: 2 };

/** Whether `plan` (or an enterprise member, who can reach anything) satisfies a model's min_tier. */
export function planSatisfiesTier(plan: Plan, minTier: Plan): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[minTier];
}
