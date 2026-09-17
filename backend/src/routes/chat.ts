import { Router } from "express";
import * as controller from "../controllers/chatController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { concurrencyLimit, rateLimit } from "../middleware/rateLimit.js";

export const chatRouter = Router();

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
chatRouter.delete("/conversations/:id", asyncHandler(controller.deleteConversation));
chatRouter.get("/conversations/:id/messages", asyncHandler(controller.listMessages));
chatRouter.post(
  "/conversations/:id/messages/stream",
  chatBurstLimit,
  chatDailyLimit,
  chatConcurrencyLimit,
  asyncHandler(controller.streamMessage),
);
