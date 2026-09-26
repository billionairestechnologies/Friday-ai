import { Router } from "express";
import * as controller from "../controllers/automationsController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";

export const automationsRouter = Router();
automationsRouter.use(requireAuth);
automationsRouter.get("/", asyncHandler(controller.list));
automationsRouter.post("/", asyncHandler(controller.create));
automationsRouter.patch("/:id", asyncHandler(controller.update));
automationsRouter.delete("/:id", asyncHandler(controller.remove));
automationsRouter.post("/:id/run", asyncHandler(controller.runNow));
