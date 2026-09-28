import { Router } from "express";
import * as controller from "../controllers/buildController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";

export const buildRouter = Router();
buildRouter.use(requireAuth);
buildRouter.post("/:conversationId/preview", asyncHandler(controller.preview));
buildRouter.get("/:conversationId/files", asyncHandler(controller.files));
buildRouter.get("/:conversationId/download", asyncHandler(controller.download));
