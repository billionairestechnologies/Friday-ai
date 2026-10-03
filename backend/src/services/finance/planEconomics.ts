import { supabaseAdmin } from "../../config/supabase.js";
import { getPlanCatalog, type CatalogPlan } from "../quota/planCatalog.js";
import { CREDITS_PER_USD } from "../quota/meter.js";
import { loadFinanceSettings, type FinanceSettings } from "./pricing.js";
import { listExpenses, occurrencesInWindow } from "./expenses.js";

/**
 * Profit per plan: price vs what one subscriber can cost us at the plan's caps. Costs change (supplier
 * deal, E2B, hosting), so everything here is computed live from Console → Finance and Expenses:
 *   usage cost  — the plan's monthly credits at the current model rates (credits are real cost);
 *   E2B         — what builders on this plan actually used in the last 30 days (sandbox time × rate);
 *   overhead    — recurring hosting / domains / E2B fees / tools ÷ paying users.
 * `suggested` re-sizes the caps so worst-case usage stays inside the target share of the price.
 */

/** Expense categories that are fixed platform running costs (not people or marketing). */
export const OVERHEAD_CATEGORIES = ["infrastructure", "hosting", "sandbox", "domains", "software"];

export type PlanEconomicsInput = {
  plan: Pick<CatalogPlan, "id" | "name" | "monthlyPricePaise" | "limits">;
  /** Average E2B ₹ per subscriber of this plan over the last 30 days (actual sandbox time). */
  e2bAvgInr: number;
  subscribers: number;
};

export type PlanEconomics = {
  id: string;
  name: string;
  priceInr: number;
  /** Monthly cap in credits (enterprise: per seat); weekly × 4.3 stands in when there's no monthly cap. */
  monthlyCredits: number;
  /** What the monthly cap is worth in model cost, ₹ — the worst case one subscriber can cost us. */
  usageCostInr: number;
  /** The same cap in millions of tokens at the blended rate; null when the blended rate is off. */
  tokensMillions: number | null;
  e2bAvgInr: number;
  overheadInr: number;
  totalCostInr: number;
  marginInr: number;
  marginPct: number | null;
  status: "ok" | "tight" | "loss";
  subscribers: number;
  suggested: { weekly: number; rolling: number; monthly: number | null; tokensPerSeat: number | null };
};

const creditsToInr = (credits: number, s: FinanceSettings) => (credits / CREDITS_PER_USD) * s.usd_to_inr;
const inrToCredits = (inr: number, s: FinanceSettings) => Math.floor((inr / s.usd_to_inr) * CREDITS_PER_USD);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Pure: one plan's economics (tested without a database). */
export function computePlanEconomics(input: PlanEconomicsInput, s: FinanceSettings, overheadPerPaidUserInr: number): PlanEconomics {
  const { plan } = input;
  const enterprise = plan.id === "enterprise";
  const free = plan.id === "free";
  const priceInr = plan.monthlyPricePaise / 100;
  const { limits } = plan;
  const monthlyCredits = enterprise ? (limits.tokensPerSeat ?? 0) : (limits.monthly ?? Math.round(limits.weekly * 4.3));

  const usageCostInr = creditsToInr(monthlyCredits, s);
  const overheadInr = free ? 0 : overheadPerPaidUserInr;
  const totalCostInr = usageCostInr + input.e2bAvgInr + overheadInr;
  const marginInr = priceInr - totalCostInr;
  const marginPct = priceInr > 0 ? r2((marginInr / priceInr) * 100) : null;

  // Suggested caps: worst-case usage ≤ target share of the price (Free: its monthly cost budget),
  // keeping the plan's own 5-hour : weekly : monthly proportions.
  const budgetInr = free ? s.free_cost_budget_inr : (priceInr * s.target_cost_share_pct) / 100;
  const suggestedMonthly = Math.max(1, inrToCredits(budgetInr, s));
  const ratio = monthlyCredits > 0 ? suggestedMonthly / monthlyCredits : 1;
  const scaled = (n: number) => Math.max(1, Math.round(n * ratio));
  const suggested = enterprise
    ? { weekly: 0, rolling: 0, monthly: null, tokensPerSeat: suggestedMonthly }
    : {
        weekly: free ? Math.max(1, Math.round(suggestedMonthly / 4.3)) : scaled(limits.weekly),
        rolling: scaled(limits.rolling),
        monthly: free && limits.monthly == null ? null : suggestedMonthly,
        tokensPerSeat: null,
      };

  const share = priceInr > 0 ? (usageCostInr / priceInr) * 100 : free ? (usageCostInr / Math.max(1, s.free_cost_budget_inr)) * 100 : 0;
  const status: PlanEconomics["status"] = free
    ? usageCostInr > s.free_cost_budget_inr * 1.05 ? "tight" : "ok"
    : marginInr < 0 ? "loss" : share > s.target_cost_share_pct * 1.05 ? "tight" : "ok";

  return {
    id: plan.id,
    name: plan.name,
    priceInr: r2(priceInr),
    monthlyCredits,
    usageCostInr: r2(usageCostInr),
    tokensMillions: s.blended_cost_per_m_inr > 0 ? r2(usageCostInr / s.blended_cost_per_m_inr) : null,
    e2bAvgInr: r2(input.e2bAvgInr),
    overheadInr: r2(overheadInr),
    totalCostInr: r2(totalCostInr),
    marginInr: r2(marginInr),
    marginPct,
    status,
    subscribers: input.subscribers,
    suggested,
  };
}

async function fixedMonthlyOverheadInr(): Promise<number> {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  let total = 0;
  for (const e of await listExpenses({ to })) {
    if (e.is_model_credits || !OVERHEAD_CATEGORIES.includes(e.category)) continue;
    // Yearly domains and the like are spread over 12 months so one big renewal doesn't distort a plan's margin.
    if (e.recurrence === "yearly") total += e.amount_inr / 12;
    else total += e.amount_inr * occurrencesInWindow(e, from, to);
  }
  return total;
}

/** Sandbox seconds per plan over the last 30 days, and how many accounts are on each plan. */
async function planUsageStats(): Promise<{ subscribers: Record<string, number>; sandboxSecondsByPlan: Record<string, number> }> {
  const subscribers: Record<string, number> = {};
  for (const plan of ["free", "pro", "premium"]) {
    const { count } = await supabaseAdmin.from("profiles").select("id", { count: "exact", head: true }).eq("plan", plan);
    subscribers[plan] = count ?? 0;
  }
  const { data: orgs } = await supabaseAdmin.from("organizations").select("seat_count").eq("plan", "enterprise");
  subscribers.enterprise = (orgs ?? []).reduce((n, o) => n + Number(o.seat_count ?? 0), 0);

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const perUser = new Map<string, number>();
  for (let offset = 0; offset < 100_000; offset += 1000) {
    const { data, error } = await supabaseAdmin
      .from("usage_events")
      .select("user_id, quantity")
      .eq("event_type", "sandbox_second")
      .gte("created_at", since)
      .order("created_at")
      .range(offset, offset + 999);
    if (error) break;
    for (const r of data ?? []) perUser.set(r.user_id as string, (perUser.get(r.user_id as string) ?? 0) + Number(r.quantity ?? 0));
    if (!data || data.length < 1000) break;
  }
  const sandboxSecondsByPlan: Record<string, number> = {};
  const ids = [...perUser.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabaseAdmin.from("profiles").select("id, plan").in("id", ids.slice(i, i + 200));
    for (const p of data ?? []) sandboxSecondsByPlan[p.plan as string] = (sandboxSecondsByPlan[p.plan as string] ?? 0) + (perUser.get(p.id as string) ?? 0);
  }
  return { subscribers, sandboxSecondsByPlan };
}

export async function planEconomics() {
  const [catalog, s, overheadMonthlyInr, stats] = await Promise.all([getPlanCatalog(), loadFinanceSettings(), fixedMonthlyOverheadInr(), planUsageStats()]);
  const paying = (stats.subscribers.pro ?? 0) + (stats.subscribers.premium ?? 0) + (stats.subscribers.enterprise ?? 0);
  const overheadPerPaidUserInr = overheadMonthlyInr / Math.max(1, paying);
  const plans = catalog.map((plan) => {
    const subscribers = stats.subscribers[plan.id] ?? 0;
    const e2bTotal = ((stats.sandboxSecondsByPlan[plan.id] ?? 0) / 3600) * s.e2b_cost_per_hour_inr;
    return computePlanEconomics({ plan, subscribers, e2bAvgInr: subscribers > 0 ? e2bTotal / subscribers : 0 }, s, overheadPerPaidUserInr);
  });
  return { settings: s, overheadMonthlyInr: r2(overheadMonthlyInr), payingUsers: paying, overheadPerPaidUserInr: r2(overheadPerPaidUserInr), plans };
}
