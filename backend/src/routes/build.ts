import { Router } from "express";
import * as controller from "../controllers/buildController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";

export const buildRouter = Router();
buildRouter.use(requireAuth);
buildRouter.get("/sessions", asyncHandler(controller.sessions));
buildRouter.get("/:conversationId/approvals", asyncHandler(controller.approvals));
buildRouter.post("/:conversationId/approve", asyncHandler(controller.approve));
buildRouter.get("/:conversationId/events", asyncHandler(controller.events));
buildRouter.get("/:conversationId/checkpoints", asyncHandler(controller.checkpoints));
buildRouter.post("/:conversationId/restore", asyncHandler(controller.restore));
buildRouter.post("/:conversationId/preview", asyncHandler(controller.preview));
buildRouter.get("/:conversationId/files", asyncHandler(controller.files));
buildRouter.get("/:conversationId/download", asyncHandler(controller.download));
