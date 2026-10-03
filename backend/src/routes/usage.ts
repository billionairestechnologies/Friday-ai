import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { usageSummary, BREAKDOWN_EVENT_TYPES } from "../services/usageService.js";
import { getQuotaStatus } from "../services/quota/tokenQuotaService.js";
import { resolveEntitlements } from "../services/quota/entitlements.js";
import { supabaseAdmin } from "../config/supabase.js";
import { nextWeeklyReset } from "../services/quota/tierConfig.js";

export const usageRouter = Router();

usageRouter.use(requireAuth);

usageRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    res.json(await usageSummary(req.user!.id));
  }),
);

/**
 * Buckets usage_events for a user since `since` into a per-feature breakdown. Always returns one
 * entry per BREAKDOWN_EVENT_TYPES (chat/search/voice/build(sandbox)/attachments), defaulting
 * unused ones to 0 so the Usage panel's dot row is stable rather than appearing/disappearing.
 */
async function computeBreakdown(userId: string, since: Date) {
  const { data: events } = await supabaseAdmin
    .from("usage_events")
    .select("event_type, quantity")
    .eq("user_id", userId)
    .in("event_type", BREAKDOWN_EVENT_TYPES)
    .gte("created_at", since.toISOString());

  const byType: Record<string, number> = Object.fromEntries(BREAKDOWN_EVENT_TYPES.map((t) => [t, 0]));
  for (const row of events ?? []) {
    byType[row.event_type] = (byType[row.event_type] ?? 0) + Number(row.quantity ?? 0);
  }
  const total = Object.values(byType).reduce((sum, n) => sum + n, 0);
  return BREAKDOWN_EVENT_TYPES.map((type) => ({
    type,
    quantity: byType[type],
    percent: total > 0 ? Math.round((byType[type] / total) * 100) : 0,
  })).sort((a, b) => b.quantity - a.quantity);
}

const FEATURES = ["chat", "build", "research", "teamup", "spark", "automation"];

/**
 * Where the usage went, by what it COST (the ledger's exact per-call cost), not by how many events
 * happened: ten chat messages and one Build turn are nowhere near equal. Percent shares only —
 * users never see money or credits. Empty (older server data / no calls yet) → null so the caller
 * falls back to the event-count breakdown.
 */
async function computeCostBreakdown(userId: string, since: Date) {
  const { data, error } = await supabaseAdmin
    .from("token_ledger")
    .select("feature, cost_usd")
    .eq("user_id", userId)
    .gte("created_at", since.toISOString())
    .limit(5000);
  if (error || !data?.length) return null;
  const byFeature = new Map<string, number>();
  for (const row of data) {
    const feature = FEATURES.includes(row.feature as string) ? (row.feature as string) : "chat";
    byFeature.set(feature, (byFeature.get(feature) ?? 0) + Number(row.cost_usd ?? 0));
  }
  const total = [...byFeature.values()].reduce((n, v) => n + v, 0);
  if (total <= 0) return null;
  return [...byFeature.entries()]
    .map(([type, cost]) => ({ type, quantity: Math.round(cost * 100_000), percent: Math.round((cost / total) * 100) }))
    .sort((a, b) => b.quantity - a.quantity);
}

/**
 * Everything the Usage settings panel needs in one call: the real token-quota status (rolling
 * 5h/weekly/monthly or org pool — see tokenQuotaService.getQuotaStatus) for the headline bars, plus
 * a feature breakdown per bar (by usage_events event_type, since a count is what we actually track
 * per-feature — not a per-feature token split) for the colored-dot list underneath each one.
 */
usageRouter.get(
  "/quota",
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const status = await getQuotaStatus(userId);

    const now = Date.now();
    const weekStart = new Date(nextWeeklyReset().getTime() - 7 * 24 * 60 * 60 * 1000);
    const rollingStart = new Date(now - 5 * 60 * 60 * 1000);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const [breakdown, rollingBreakdown, monthlyBreakdown, access] = await Promise.all([
      computeCostBreakdown(userId, weekStart).then((b) => b ?? computeBreakdown(userId, weekStart)),
      computeCostBreakdown(userId, rollingStart).then((b) => b ?? computeBreakdown(userId, rollingStart)),
      computeCostBreakdown(userId, monthStart).then((b) => b ?? computeBreakdown(userId, monthStart)),
      resolveEntitlements(userId).catch(() => null),
    ]);

    res.json({ status, breakdown, rollingBreakdown, monthlyBreakdown, entitlements: access?.entitlements ?? null });
  }),
);
