import { Router } from "express";
import * as controller from "../controllers/chatController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { concurrencyLimit, rateLimit } from "../middleware/rateLimit.js";
import { quotaLimit } from "../middleware/quotaLimit.js";

export const chatRouter = Router();

/** Public, unauthenticated read-only view of a shared chat (rate limited per IP). */
export const shareRouter = Router();
shareRouter.get(
  "/:token",
  rateLimit({ name: "share-view", limit: 120, windowMs: 60_000 }),
  asyncHandler(controller.getShared),
);

chatRouter.use(requireAuth);

const chatBurstLimit = rateLimit({
  name: "chat-stream-minute",
  limit: env.rateLimits.chatPerMinute,
  windowMs: 60_000,
});
const chatDailyLimit = rateLimit({
  name: "chat-stream-day",
  limit: env.rateLimits.chatPerDay,
  windowMs: 24 * 60 * 60_000,
});
const chatConcurrencyLimit = concurrencyLimit("chat-stream", env.rateLimits.chatConcurrency);

chatRouter.post("/conversations", asyncHandler(controller.createConversation));
chatRouter.patch("/conversations/:id", asyncHandler(controller.updateConversation));
chatRouter.get("/conversations", asyncHandler(controller.listConversations));
chatRouter.delete("/conversations", asyncHandler(controller.deleteAllConversations));
chatRouter.delete("/conversations/:id", asyncHandler(controller.deleteConversation));
chatRouter.get("/conversations/:id/messages", asyncHandler(controller.listMessages));
chatRouter.get("/search", asyncHandler(controller.search));
chatRouter.post("/conversations/:id/share", asyncHandler(controller.share));
chatRouter.delete("/conversations/:id/share", asyncHandler(controller.unshare));
chatRouter.post(
  "/conversations/:id/messages/stream",
  chatBurstLimit,
  chatDailyLimit,
  chatConcurrencyLimit,
  quotaLimit,
  asyncHandler(controller.streamMessage),
);
chatRouter.post("/conversations/:id/stop", asyncHandler(controller.stopMessage));
chatRouter.get("/conversations/:id/live", asyncHandler(controller.live));
