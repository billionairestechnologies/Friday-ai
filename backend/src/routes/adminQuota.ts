import { Router } from "express";
import * as controller from "../controllers/adminQuotaController.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, requireStaff } from "../services/console/permissions.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const adminQuotaRouter = Router();

// Team Console staff with the matching permission (admin accounts are owners and pass everything):
// reads need users.view, changes need users.manage.
adminQuotaRouter.use(requireAuth, requireStaff, (req, res, next) =>
  requirePermission(req.method === "GET" ? "users.view" : "users.manage")(req, res, next),
);
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
