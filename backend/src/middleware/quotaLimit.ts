import type { NextFunction, Request, RequestHandler, Response } from "express";
import { checkAndReserve, estimateReservationTokens, settleReservation, type QuotaCheckResult, type Reservation } from "../services/quota/tokenQuotaService.js";
import { httpStatusFor, QUOTA_REASON_TEXT } from "../services/quota/allowance.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      quotaReservation?: Reservation;
    }
  }
}

/**
 * The structured error every client gets when a billable request is refused. `reason` keeps the
 * cases apart — exhausted / member_cap (the customer's own limit, 429), suspended (403),
 * unavailable (our ledger is down, 503) — so a provider outage or our own hiccup is never shown as
 * "you're out of tokens".
 */
export function quotaErrorBody(result: Extract<QuotaCheckResult, { allowed: false }>, requestId?: string) {
  const resetAt = result.resetAt?.toISOString() ?? null;
  const when = result.resetAt
    ? ` Your allowance renews ${result.resetAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })} IST, or upgrade your plan to continue now.`
    : "";
  return {
    status: httpStatusFor(result.reason),
    body: {
      error: `${QUOTA_REASON_TEXT[result.reason]}.${result.reason === "exhausted" || result.reason === "member_cap" ? when : ""}`,
      code: `quota_${result.reason}`,
      reason: result.reason,
      allowance: result.snapshot?.allowance ?? null,
      used: result.snapshot ? result.snapshot.used + result.snapshot.adjustments : null,
      remaining: result.snapshot ? Math.max(0, result.snapshot.remaining) : null,
      resetAt,
      requestId,
    },
  };
}

/**
 * Pre-flight quota gate for the chat stream route. Runs BEFORE the controller sends any SSE
 * headers, so a refusal is a real HTTP status with a structured body. Holds an estimate from the
 * raw body (message + attachments); streamMessage grows the hold to the real prompt once it has
 * built it, and settles the reservation when the turn ends.
 */
export const quotaLimit: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    const userId = req.user?.id;
    if (!userId) return next();

    const content = typeof req.body?.content === "string" ? req.body.content : "";
    const attachmentBytes = Array.isArray(req.body?.attachments)
      ? req.body.attachments.reduce((sum: number, a: { size?: number }) => sum + (a?.size ?? 0), 0)
      : 0;
    // A vision/document attachment costs real prompt tokens too — folded in as a rough per-KB add-on.
    const reserveTokens = estimateReservationTokens(content.length + attachmentBytes / 50);
    const conversationId = typeof req.params?.id === "string" ? req.params.id : typeof req.body?.conversationId === "string" ? req.body.conversationId : null;

    const result = await checkAndReserve(userId, reserveTokens, { feature: "chat", conversationId });
    if (!result.allowed) {
      const { status, body } = quotaErrorBody(result, req.requestId);
      if (result.resetAt) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000))));
        res.setHeader("X-Quota-Reset", result.resetAt.toISOString());
      }
      res.status(status).json(body);
      return;
    }

    req.quotaReservation = result.reservation;
    // A request that never reaches the controller (validation error, client gone) must not keep its hold.
    res.on("close", () => {
      if (!res.locals.quotaHandedOff) void settleReservation(result.reservation);
    });
    next();
  })().catch(next);
};
