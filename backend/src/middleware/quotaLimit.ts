import type { NextFunction, Request, RequestHandler, Response } from "express";
import { checkAndReserve, estimateReservationTokens, type Reservation } from "../services/quota/tokenQuotaService.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      quotaReservation?: Reservation;
    }
  }
}

const REASON_LABEL: Record<string, string> = {
  rolling_window: "You've hit your 5-hour usage limit",
  weekly: "You've hit your weekly usage limit",
  monthly: "You've hit your monthly usage limit",
  org_pool: "Your organization's monthly token pool is exhausted",
  member_cap: "You've hit the monthly cap your org admin set for you",
};

/**
 * Pre-flight token-quota gate for the chat stream route. Runs as ordinary Express middleware —
 * BEFORE the controller sends any SSE headers — so unlike a mid-stream rejection this can return
 * a real HTTP 429 with standard headers. Estimates the reservation from the raw request body
 * (before the controller's zod parse) since that's all a middleware has to work with; the
 * reservation this attaches to `req.quotaReservation` travels through the controller into
 * chat/index.ts's streamMessage, which reconciles it against the real token count once known.
 */
export const quotaLimit: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    const userId = req.user?.id;
    if (!userId) return next();

    const content = typeof req.body?.content === "string" ? req.body.content : "";
    const attachmentBytes = Array.isArray(req.body?.attachments)
      ? req.body.attachments.reduce((sum: number, a: { size?: number }) => sum + (a?.size ?? 0), 0)
      : 0;
    // A vision/document attachment costs real prompt tokens too (the image/OCR text goes into
    // the same request) — folded into the estimate as a rough per-KB add-on so a message with a
    // large attachment doesn't slip through reserving only for its (often tiny) caption text.
    const reserveTokens = estimateReservationTokens(content.length + attachmentBytes / 50);

    const result = await checkAndReserve(userId, reserveTokens);
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.setHeader("X-Quota-Reset", result.resetAt.toISOString());
      res.status(429).json({
        error: `${REASON_LABEL[result.decision.reason] ?? "Usage limit reached"} — resets ${result.resetAt.toLocaleString()}.`,
        reason: result.decision.reason,
        limit: result.decision.limit,
        used: result.decision.used,
        resetAt: result.resetAt.toISOString(),
        requestId: req.requestId,
      });
      return;
    }

    req.quotaReservation = result.reservation;
    next();
  })().catch(next);
};
