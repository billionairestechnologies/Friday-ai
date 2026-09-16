import { Router } from "express";
import * as controller from "../controllers/sandboxController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";

export const sandboxRouter = Router();

sandboxRouter.use(requireAuth);

sandboxRouter.post("/run", asyncHandler(controller.run));
