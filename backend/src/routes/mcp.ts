import { Router } from "express";
import * as controller from "../controllers/mcpController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";

export const mcpRouter = Router();
mcpRouter.use(requireAuth);
mcpRouter.get("/", asyncHandler(controller.list));
mcpRouter.post("/", asyncHandler(controller.create));
mcpRouter.patch("/:id", asyncHandler(controller.update));
mcpRouter.delete("/:id", asyncHandler(controller.remove));
mcpRouter.get("/:id/tools", asyncHandler(controller.tools));
