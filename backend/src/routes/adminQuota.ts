import { Router } from "express";
import * as controller from "../controllers/adminQuotaController.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const adminQuotaRouter = Router();

adminQuotaRouter.use(requireAuth, requireAdmin);
adminQuotaRouter.use(
  rateLimit({
    name: "admin-quota-management",
    limit: 600,
    windowMs: 15 * 60_000,
  }),
);

adminQuotaRouter.get("/users", asyncHandler(controller.listUsers));
adminQuotaRouter.patch("/users/:userId/plan", asyncHandler(controller.setUserPlan));
adminQuotaRouter.patch("/users/:userId/custom-cap", asyncHandler(controller.setUserCustomCap));
adminQuotaRouter.post("/users/:userId/bonus-tokens", asyncHandler(controller.grantBonus));
adminQuotaRouter.post("/users/:userId/reset-quota", asyncHandler(controller.resetQuota));

adminQuotaRouter.get("/organizations", asyncHandler(controller.listOrganizations));
adminQuotaRouter.patch("/organizations/:orgId/plan", asyncHandler(controller.setOrganizationPlan));
adminQuotaRouter.patch("/organizations/:orgId/seats", asyncHandler(controller.setOrganizationSeats));
adminQuotaRouter.patch("/organizations/:orgId/pooled-tokens", asyncHandler(controller.setOrganizationPooledTokens));

adminQuotaRouter.get("/profitability", asyncHandler(controller.profitability));
