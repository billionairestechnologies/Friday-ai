import { create } from "zustand";
import type { Entitlements } from "@/lib/billing/checkout";
import type { QuotaResponse } from "./quota";
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
  /** Null until the first successful quota read. A missing key means the server hasn't shipped that feature flag. */
  entitlements: Entitlements | null;
  apply: (res: QuotaResponse) => void;
  load: () => Promise<void>;
};

/**
 * The viewer's plan and which features it includes. QuotaAlerts polls /usage/quota and calls
 * apply(), so an admin turning Build Mode or Canvas off shows up on the next poll without a reload.
 */
export const usePlan = create<PlanState>((set, get) => ({
  plan: "free",
  isEnterprise: false,
  loaded: false,
  entitlements: null,
  apply: (res) => set({ plan: res.status.plan, isEnterprise: res.status.isEnterprise, entitlements: res.entitlements ?? null, loaded: true }),
  load: async () => {
    if (get().loaded) return;
    // Shares the one /usage/quota fetch with the Usage panel and alerts (lib/usage/quotaStore.ts).
    await useQuota.getState().load(60_000);
    const res = useQuota.getState().data;
    if (res) get().apply(res);
    else set({ loaded: true });
  },
}));
