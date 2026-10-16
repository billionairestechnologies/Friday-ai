import type { Request, Response } from "express";
import { z } from "zod";
import * as e2bService from "../services/e2bService.js";
import { recordUsageEvent } from "../services/usageService.js";
import { checkAndReserve, estimateReservationTokens } from "../services/quota/tokenQuotaService.js";
import { UsageMeter } from "../services/quota/usageMeter.js";
import { withMeter } from "../services/quota/meterContext.js";
import { quotaErrorBody } from "../middleware/quotaLimit.js";

const runSchema = z.object({
  language: z.enum(["python", "javascript", "typescript", "r", "java", "bash"]),
  code: z.string().min(1, "Code cannot be empty").max(50_000),
  // Defaults on: Canvas auto-runs code the moment it lands, and a failure should self-heal
  // rather than just hand the user a stack trace — see runWithAutoFix's own comment for the
  // attempt cap. Callers doing an explicit manual re-run of unmodified code can still turn it
  // off to avoid silently rewriting code the user is looking at.
  autoFix: z.boolean().default(true),
});

export async function run(req: Request, res: Response) {
  const { language, code, autoFix } = runSchema.parse(req.body);
  if (autoFix) {
    // Each fix attempt is a model call: metered like any chat turn. Without allowance the code still
    // runs (that costs no tokens) — it just isn't auto-fixed, and the client is told why.
    const check = await checkAndReserve(req.user!.id, estimateReservationTokens(code.length * 2, 2_000), { feature: "chat" });
    if (!check.allowed) {
      const result = await e2bService.runCode(req.user!.id, language, code);
      void recordUsageEvent(req.user!.id, "sandbox_run", 1, { language, autoFix: false, ok: result.ok, quota: check.reason });
      res.json({ ...result, code, attempts: [{ code, result }], quota: quotaErrorBody(check).body });
      return;
    }
    const meter = new UsageMeter(check.reservation, { userId: req.user!.id, organizationId: check.reservation.organizationId, feature: "chat" });
    let result: Awaited<ReturnType<typeof e2bService.runWithAutoFix>>;
    try {
      result = await withMeter(meter, () => e2bService.runWithAutoFix(req.user!.id, language, code, (tokens) => meter.ensureHold(tokens)));
    } finally {
      await meter.settle();
    }
    void recordUsageEvent(req.user!.id, "sandbox_run", 1, {
      language,
      autoFix,
      attempts: result.attempts.length,
      ok: result.ok,
    });
    res.json(result);
    return;
  }
  const result = await e2bService.runCode(req.user!.id, language, code);
  void recordUsageEvent(req.user!.id, "sandbox_run", 1, { language, autoFix, ok: result.ok });
  res.json({ ...result, code, attempts: [{ code, result }] });
}
