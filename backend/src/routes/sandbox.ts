import { Router } from "express";
import * as controller from "../controllers/sandboxController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { env } from "../config/env.js";
import { concurrencyLimit, rateLimit } from "../middleware/rateLimit.js";

export const sandboxRouter = Router();

sandboxRouter.use(requireAuth);

const sandboxLimit = rateLimit({
  name: "sandbox-run",
  limit: env.rateLimits.sandboxPer10Minutes,
  windowMs: 10 * 60_000,
});
const sandboxConcurrencyLimit = concurrencyLimit("sandbox-run", env.rateLimits.sandboxConcurrency);

sandboxRouter.post("/run", sandboxLimit, sandboxConcurrencyLimit, asyncHandler(controller.run));
