import { Router } from "express";
import * as controller from "../controllers/adminProvidersController.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const adminProvidersRouter = Router();

adminProvidersRouter.use(requireAuth, requireAdmin);
adminProvidersRouter.use(
  rateLimit({
    name: "admin-provider-management",
    limit: 60,
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
