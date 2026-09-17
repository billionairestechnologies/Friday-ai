import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import {
  createOrganization,
  inviteOrganizationMember,
  acceptOrganizationInvite,
  listOrganizationMembers,
  listOrganizationsForUser,
  updateOrganizationBudget,
} from "../services/organizationService.js";
import { env } from "../config/env.js";

export const organizationsRouter = Router();

organizationsRouter.get(
  "/sso",
  asyncHandler(async (_req, res) => {
    res.json({
      enabled: env.ssoEnabled,
      entryUrl: env.ssoEnabled ? env.ssoEntryUrl || null : null,
      providerLabel: env.ssoProviderLabel,
    });
  }),
);

organizationsRouter.use(requireAuth);

organizationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ organizations: await listOrganizationsForUser(req.user!.id) });
  }),
);

const createOrgSchema = z.object({
  name: z.string().trim().min(2).max(120),
});

organizationsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name } = createOrgSchema.parse(req.body);
    res.status(201).json({ organization: await createOrganization(req.user!.id, name) });
  }),
);

const acceptInviteSchema = z.object({
  token: z.string().trim().min(16).max(200),
});

organizationsRouter.post(
  "/invites/accept",
  asyncHandler(async (req, res) => {
    const { token } = acceptInviteSchema.parse(req.body);
    res.json({ membership: await acceptOrganizationInvite(req.user!.id, token) });
  }),
);

organizationsRouter.get(
  "/:organizationId/members",
  asyncHandler(async (req, res) => {
    const organizationId = z.string().uuid().parse(req.params.organizationId);
    res.json({ members: await listOrganizationMembers(req.user!.id, organizationId) });
  }),
);

const budgetSchema = z.object({
  monthlyBudgetCents: z.number().int().min(0).max(100_000_000),
});

organizationsRouter.patch(
  "/:organizationId/budget",
  asyncHandler(async (req, res) => {
    const organizationId = z.string().uuid().parse(req.params.organizationId);
    const { monthlyBudgetCents } = budgetSchema.parse(req.body);
    res.json({
      organization: await updateOrganizationBudget(req.user!.id, organizationId, monthlyBudgetCents),
    });
  }),
);

const inviteSchema = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum(["admin", "member"]).default("member"),
});

organizationsRouter.post(
  "/:organizationId/invites",
  asyncHandler(async (req, res) => {
    const organizationId = z.string().uuid().parse(req.params.organizationId);
    const { email, role } = inviteSchema.parse(req.body);
    res.status(201).json({
      invite: await inviteOrganizationMember(req.user!.id, organizationId, email, role),
    });
  }),
);
