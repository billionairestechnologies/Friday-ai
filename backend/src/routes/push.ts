import { Router } from "express";
import * as controller from "../controllers/pushController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";

export const pushRouter = Router();
pushRouter.use(requireAuth);
pushRouter.get("/config", controller.config);
pushRouter.post("/subscriptions", asyncHandler(controller.register));
pushRouter.delete("/subscriptions", asyncHandler(controller.unregister));
