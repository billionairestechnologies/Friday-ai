import { Router } from "express";
import * as controller from "../controllers/chatController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";

export const chatRouter = Router();

chatRouter.use(requireAuth);

chatRouter.post("/conversations", asyncHandler(controller.createConversation));
chatRouter.patch("/conversations/:id", asyncHandler(controller.updateConversation));
chatRouter.get("/conversations", asyncHandler(controller.listConversations));
chatRouter.delete("/conversations/:id", asyncHandler(controller.deleteConversation));
chatRouter.get("/conversations/:id/messages", asyncHandler(controller.listMessages));
chatRouter.post("/conversations/:id/messages/stream", asyncHandler(controller.streamMessage));
