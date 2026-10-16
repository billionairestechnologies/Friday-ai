import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { usageSummary } from "../services/usageService.js";
import { getQuotaStatus } from "../services/quota/tokenQuotaService.js";
import { usageReport } from "../services/quota/usageReport.js";
import { resolveEntitlements } from "../services/quota/entitlements.js";
import { USAGE_NOTICE_THRESHOLDS } from "../services/quota/allowance.js";

export const usageRouter = Router();

usageRouter.use(requireAuth);

usageRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    res.json(await usageSummary(req.user!.id));
  }),
);

/**
 * Everything the Usage panel needs in one call, all from the server-side ledger: the period's
 * balance (allowance, finalized usage, adjustments, active holds, remaining, renewal), and where
 * the tokens went (by model, feature and day, recent calls, estimated vs provider-reported).
 * Only the caller's own rows are ever returned; an enterprise member sees the org pool's balance
 * but only their own calls.
 *
 * `breakdown` / `monthlyBreakdown` keep the older shape (feature, quantity, percent) for the mobile apps.
 */
usageRouter.get(
  "/quota",
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const status = await getQuotaStatus(userId);
    const [report, access] = await Promise.all([
      usageReport(status.period.accountId, status.period.start, userId, { includeAdjustments: !status.isEnterprise }),
      resolveEntitlements(userId).catch(() => null),
    ]);
    const total = report.byFeature.reduce((sum, f) => sum + f.billable, 0);
    const breakdown = report.byFeature.map((f) => ({ type: f.feature, quantity: f.billable, percent: total > 0 ? Math.round((f.billable / total) * 100) : 0 }));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      status,
      report,
      thresholds: USAGE_NOTICE_THRESHOLDS,
      breakdown,
      monthlyBreakdown: breakdown,
      rollingBreakdown: [],
      entitlements: access?.entitlements ?? null,
    });
  }),
);
