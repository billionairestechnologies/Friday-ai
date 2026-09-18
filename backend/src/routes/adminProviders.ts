import { Router } from "express";
import * as controller from "../controllers/adminProvidersController.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const adminProvidersRouter = Router();

adminProvidersRouter.use(requireAuth, requireAdmin);
// A single bulk-management session (re-sync a provider, then enable + set a tier on ~20 newly
// discovered models) fires several requests per model — the old limit of 60/15min was tripped
// mid-session by exactly that workflow, leaving the Providers list permanently 429ing until the
// window rolled over. Admin actions here are already gated behind requireAdmin, so this exists to
// catch a runaway loop, not to throttle a legitimate admin doing real work.
adminProvidersRouter.use(
  rateLimit({
    name: "admin-provider-management",
    limit: 600,
    windowMs: 15 * 60_000,
  }),
);

adminProvidersRouter.get("/", asyncHandler(controller.listProviders));
adminProvidersRouter.post("/:slug/keys", asyncHandler(controller.addKey));
adminProvidersRouter.delete("/keys/:keyId", asyncHandler(controller.deleteKey));
adminProvidersRouter.post("/keys/:keyId/check", asyncHandler(controller.checkKey));
adminProvidersRouter.post("/keys/check-all", asyncHandler(controller.checkAllKeys));
adminProvidersRouter.post("/:slug/sync", asyncHandler(controller.syncModels));
adminProvidersRouter.get("/:slug/models", asyncHandler(controller.listProviderModels));
adminProvidersRouter.patch("/models/:modelId", asyncHandler(controller.setModelEnabled));
adminProvidersRouter.patch("/models/:modelId/tier", asyncHandler(controller.setModelMinTier));
