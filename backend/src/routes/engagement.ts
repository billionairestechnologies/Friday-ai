import { Router } from "express";
import * as c from "../controllers/engagementController.js";
import * as plans from "../controllers/plansController.js";
import * as prog from "../controllers/programController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { rateLimit } from "../middleware/rateLimit.js";

/** /api/updates — What's New popups for the signed-in user. */
export const updatesRouter = Router();
updatesRouter.get("/pending", requireAuth, asyncHandler(c.pendingUpdates));
updatesRouter.post("/seen", requireAuth, asyncHandler(c.markUpdatesSeen)); // older app builds
updatesRouter.post("/claim", requireAuth, asyncHandler(c.claimUpdate));
updatesRouter.post("/act", requireAuth, asyncHandler(c.actOnUpdate));

/** /api/notifications — the person's inbox and one-time benefit popups (supabase 0060/0062). */
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);
notificationsRouter.get("/", asyncHandler(c.notificationInbox));
notificationsRouter.post("/read", asyncHandler(c.notificationsRead));
notificationsRouter.get("/popups", asyncHandler(c.notificationPopups));
notificationsRouter.post("/:notificationId/claim", asyncHandler(c.claimNotificationPopup));
notificationsRouter.post("/:notificationId/ack", asyncHandler(c.acknowledgeNotification));

/** /api/support — the user's own tickets, plus the inbound-email webhook (secret-authenticated). */
export const supportRouter = Router();
supportRouter.post("/inbound", rateLimit({ name: "support-inbound", limit: 120, windowMs: 60_000 }), asyncHandler(c.inboundEmail));
supportRouter.use(requireAuth);
supportRouter.get("/tickets", asyncHandler(c.myTickets));
supportRouter.post("/tickets", rateLimit({ name: "support-open", limit: 10, windowMs: 60 * 60_000 }), asyncHandler(c.openTicket));
supportRouter.get("/tickets/:ticketId", asyncHandler(c.myTicket));
supportRouter.post("/tickets/:ticketId/reply", rateLimit({ name: "support-reply", limit: 60, windowMs: 60 * 60_000 }), asyncHandler(c.replyMyTicket));

/** /api/email — public, token-authenticated one-click unsubscribe. */
export const emailRouter = Router();
emailRouter.get("/unsubscribe", asyncHandler(c.emailUnsubscribe));
emailRouter.post("/unsubscribe", asyncHandler(c.emailUnsubscribe));
// The signed-in user's own choice about product/marketing email (account email is always sent).
emailRouter.get("/preferences", requireAuth, asyncHandler(c.emailPreferences));
emailRouter.post("/preferences", requireAuth, asyncHandler(c.updateEmailPreferences));

/** /api/offers — redeem an offer code (student pass, promo, partner deal…) and see past requests. */
export const offersRouter = Router();
offersRouter.use(requireAuth);
offersRouter.post("/redeem", rateLimit({ name: "offer-redeem", limit: 20, windowMs: 60 * 60_000 }), asyncHandler(plans.redeem));
offersRouter.get("/mine", asyncHandler(plans.mine));

/** /api/programs — student / startup / company programme applications (the applicant's side). */
export const programsRouter = Router();
programsRouter.use(requireAuth);
programsRouter.get("/", asyncHandler(prog.mine));
programsRouter.post("/apply", rateLimit({ name: "program-apply", limit: 10, windowMs: 60 * 60_000 }), asyncHandler(prog.apply));
programsRouter.post("/:applicationId/respond", rateLimit({ name: "program-respond", limit: 20, windowMs: 60 * 60_000 }), asyncHandler(prog.respond));
programsRouter.post("/:applicationId/withdraw", asyncHandler(prog.withdraw));
