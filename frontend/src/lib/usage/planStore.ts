import { create } from "zustand";
import { useQuota } from "./quotaStore";

export type Plan = "free" | "pro" | "premium";

const PLAN_RANK: Record<Plan, number> = { free: 0, pro: 1, premium: 2 };

/** Mirrors the backend's planSatisfiesTier (tierConfig.ts) — an enterprise member can use
 *  anything, otherwise the viewer's plan rank must meet or exceed the model's min_tier rank. */
export function planSatisfiesTier(plan: Plan, isEnterprise: boolean, minTier: Plan): boolean {
  return isEnterprise || PLAN_RANK[plan] >= PLAN_RANK[minTier];
}

type PlanState = {
  plan: Plan;
  isEnterprise: boolean;
  loaded: boolean;
  load: () => Promise<void>;
};

/**
 * The viewer's own plan, fetched once and cached for the session — powers the lock icon on
 * tier-gated models in the model picker. Deliberately a single lightweight fetch rather than
 * another poll loop (QuotaAlerts already polls /usage/quota for its own purpose); a plan change
 * mid-session not being reflected until the next reload is an acceptable tradeoff here.
 */
export const usePlan = create<PlanState>((set, get) => ({
  plan: "free",
  isEnterprise: false,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    // Shares the one /usage/quota fetch with the Usage panel and alerts (lib/usage/quotaStore.ts).
    await useQuota.getState().load(60_000);
    const res = useQuota.getState().data;
    set(res ? { plan: res.status.plan, isEnterprise: res.status.isEnterprise, loaded: true } : { loaded: true });
  },
}));
