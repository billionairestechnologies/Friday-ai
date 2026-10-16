import { supabaseAdmin } from "../../config/supabase.js";
import { inrPerMillionTokens } from "./planEconomics.js";
import { getPlanCatalog } from "../quota/planCatalog.js";
import { loadFinanceSettings } from "./pricing.js";

/**
 * Live usage monitor for the Team Console: what the platform is spending on models right now,
 * who is spending it, and who looks abnormal. Built from the exact per-call cost in token_ledger.
 */

export type LedgerRow = { user_id: string; provider_slug: string; model_id: string; feature: string | null; cost_usd: number | null; created_at: string };

export type LiveUsage = {
  windowHours: number;
  totalCostInr: number;
  previousCostInr: number;
  /** Cost per hour, oldest → newest, one entry per hour of the window. */
  hourly: { hour: string; costInr: number }[];
  byFeature: { feature: string; costInr: number }[];
  byModel: { provider: string; model: string; costInr: number }[];
  topUsers: { userId: string; costInr: number; calls: number }[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Pure: aggregates ledger rows for the window [now-hours, now] against the same-length window before it. */
export function aggregateLive(rows: LedgerRow[], usdToInr: number, now: number, hours = 24): LiveUsage {
  const HOUR = 3_600_000;
  const start = now - hours * HOUR;
  const prevStart = start - hours * HOUR;
  const hourly = Array.from({ length: hours }, (_, i) => ({ hour: new Date(start + i * HOUR).toISOString(), costInr: 0 }));
  const feature = new Map<string, number>();
  const model = new Map<string, number>();
  const user = new Map<string, { cost: number; calls: number }>();
  let total = 0;
  let previous = 0;
  for (const row of rows) {
    const t = Date.parse(row.created_at);
    const inr = Number(row.cost_usd ?? 0) * usdToInr;
    if (t >= prevStart && t < start) previous += inr;
    if (t < start || t > now) continue;
    total += inr;
    hourly[Math.min(hours - 1, Math.floor((t - start) / HOUR))]!.costInr += inr;
    const f = row.feature ?? "chat";
    feature.set(f, (feature.get(f) ?? 0) + inr);
    const m = `${row.provider_slug}/${row.model_id}`;
    model.set(m, (model.get(m) ?? 0) + inr);
    const u = user.get(row.user_id) ?? { cost: 0, calls: 0 };
    u.cost += inr;
    u.calls += 1;
    user.set(row.user_id, u);
  }
  const sorted = <T>(m: Map<string, T>, cost: (v: T) => number) => [...m.entries()].sort((a, b) => cost(b[1]) - cost(a[1]));
  return {
    windowHours: hours,
    totalCostInr: r2(total),
    previousCostInr: r2(previous),
    hourly: hourly.map((h) => ({ ...h, costInr: r2(h.costInr) })),
    byFeature: sorted(feature, (v) => v).map(([f, c]) => ({ feature: f, costInr: r2(c) })),
    byModel: sorted(model, (v) => v).slice(0, 10).map(([k, c]) => ({ provider: k.split("/")[0]!, model: k.slice(k.indexOf("/") + 1), costInr: r2(c) })),
    topUsers: sorted(user, (v) => v.cost).slice(0, 15).map(([userId, v]) => ({ userId, costInr: r2(v.cost), calls: v.calls })),
  };
}

/** A user is flagged when one day of usage is this share of their whole monthly allowance. */
export const SPIKE_SHARE_OF_MONTHLY = 0.25;

export function flagSpike(costInr: number, monthlyAllowanceInr: number): boolean {
  return monthlyAllowanceInr > 0 && costInr >= monthlyAllowanceInr * SPIKE_SHARE_OF_MONTHLY;
}

export async function liveUsage(hours = 24) {
  const now = Date.now();
  const since = new Date(now - 2 * hours * 3_600_000).toISOString();
  const rows: LedgerRow[] = [];
  for (let offset = 0; offset < 100_000; offset += 1000) {
    const { data, error } = await supabaseAdmin
      .from("token_ledger")
      .select("user_id, provider_slug, model_id, feature, cost_usd, created_at")
      .gte("created_at", since)
      .order("created_at")
      .range(offset, offset + 999);
    if (error) {
      // Before migration 0048 the feature column doesn't exist — retry the old shape once.
      if (/feature/.test(error.message)) {
        const retry = await supabaseAdmin.from("token_ledger").select("user_id, provider_slug, model_id, cost_usd, created_at").gte("created_at", since).limit(50_000);
        rows.push(...((retry.data ?? []) as LedgerRow[]));
      }
      break;
    }
    rows.push(...((data ?? []) as LedgerRow[]));
    if (!data || data.length < 1000) break;
  }
  const [s, catalog] = await Promise.all([loadFinanceSettings(), getPlanCatalog()]);
  const agg = aggregateLive(rows, s.usd_to_inr, now, hours);

  const ids = agg.topUsers.map((u) => u.userId);
  const { data: profiles } = ids.length ? await supabaseAdmin.from("profiles").select("id, full_name, plan").in("id", ids) : { data: [] };
  const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]));
  // ₹ value of a plan's monthly token allowance at the blended rate (what a spike is measured against).
  const allowance = (plan: string) => {
    const p = catalog.find((c) => c.id === plan);
    return ((p?.limits.monthly ?? 0) / 1_000_000) * inrPerMillionTokens(s);
  };
  const topUsers = agg.topUsers.map((u) => {
    const profile = byId.get(u.userId);
    const plan = (profile?.plan as string | undefined) ?? "free";
    const monthly = allowance(plan);
    return { ...u, name: (profile?.full_name as string | null) ?? null, plan, monthlyAllowanceInr: r2(monthly), shareOfMonthlyPct: monthly > 0 ? r2((u.costInr / monthly) * 100) : null, spike: flagSpike(u.costInr, monthly) };
  });
  return { ...agg, topUsers, spikes: topUsers.filter((u) => u.spike).length };
}
