import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { usageSummary } from "../services/usageService.js";
import { getQuotaStatus } from "../services/quota/tokenQuotaService.js";
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
 * Everything the Usage settings panel needs in one call: the real token-quota status (rolling
 * 5h/weekly/monthly or org pool — see tokenQuotaService.getQuotaStatus) for the headline bar, plus
 * a feature breakdown (by usage_events event_type, since a weekly count is what we actually track
 * per-feature — not a per-feature token split) for the colored-dot list underneath it.
 */
usageRouter.get(
  "/quota",
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const status = await getQuotaStatus(userId);

    const weekStart = new Date(nextWeeklyReset().getTime() - 7 * 24 * 60 * 60 * 1000);
    const { data: events } = await supabaseAdmin
      .from("usage_events")
      .select("event_type, quantity")
      .eq("user_id", userId)
      .gte("created_at", weekStart.toISOString());

    const byType: Record<string, number> = {};
    for (const row of events ?? []) {
      byType[row.event_type] = (byType[row.event_type] ?? 0) + Number(row.quantity ?? 0);
    }
    const total = Object.values(byType).reduce((sum, n) => sum + n, 0);
    const breakdown = Object.entries(byType)
      .filter(([type]) => type !== "token_usage")
      .map(([type, quantity]) => ({
        type,
        quantity,
        percent: total > 0 ? Math.round((quantity / total) * 100) : 0,
      }))
      .sort((a, b) => b.quantity - a.quantity);

    res.json({ status, breakdown });
  }),
);
