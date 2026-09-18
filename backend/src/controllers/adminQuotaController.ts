import type { Request, Response } from "express";
import { z } from "zod";
import * as adminUserService from "../services/adminUserService.js";
import { grantBonusTokens, resetUserQuotaNow } from "../services/quota/tokenQuotaService.js";
import { recordAdminAuditLog } from "../services/usageService.js";

export async function listUsers(_req: Request, res: Response) {
  res.json({ users: await adminUserService.listUsersForAdmin() });
}

const setPlanSchema = z.object({ plan: z.enum(["free", "pro", "premium"]), renewsInDays: z.number().int().min(1).max(365).optional() });

export async function setUserPlan(req: Request, res: Response) {
  const { plan, renewsInDays } = setPlanSchema.parse(req.body);
  await adminUserService.setUserPlan(req.params.userId, plan, renewsInDays ?? 30);
  void recordAdminAuditLog(req.user!.id, "user_plan_changed", "profile", req.params.userId, { plan });
  res.status(204).send();
}

const setCapSchema = z.object({ customMonthlyCap: z.number().int().min(0).nullable() });

export async function setUserCustomCap(req: Request, res: Response) {
  const { customMonthlyCap } = setCapSchema.parse(req.body);
  await adminUserService.setUserCustomCap(req.params.userId, customMonthlyCap);
  void recordAdminAuditLog(req.user!.id, "user_custom_cap_changed", "profile", req.params.userId, { customMonthlyCap });
  res.status(204).send();
}

const bonusSchema = z.object({ tokens: z.number().int().min(1).max(50_000_000) });

export async function grantBonus(req: Request, res: Response) {
  const { tokens } = bonusSchema.parse(req.body);
  await grantBonusTokens(req.params.userId, tokens);
  void recordAdminAuditLog(req.user!.id, "user_bonus_tokens_granted", "profile", req.params.userId, { tokens });
  res.status(204).send();
}

export async function resetQuota(req: Request, res: Response) {
  await resetUserQuotaNow(req.params.userId);
  void recordAdminAuditLog(req.user!.id, "user_quota_reset", "profile", req.params.userId);
  res.status(204).send();
}

export async function listOrganizations(_req: Request, res: Response) {
  res.json({ organizations: await adminUserService.listOrganizationsForAdmin() });
}

const setOrgPlanSchema = z.object({ plan: z.enum(["free", "pro", "business", "enterprise"]) });

export async function setOrganizationPlan(req: Request, res: Response) {
  const { plan } = setOrgPlanSchema.parse(req.body);
  await adminUserService.setOrganizationPlan(req.params.orgId, plan);
  void recordAdminAuditLog(req.user!.id, "organization_plan_changed", "organization", req.params.orgId, { plan });
  res.status(204).send();
}

const setSeatsSchema = z.object({ seatCount: z.number().int().min(1).max(10_000) });

export async function setOrganizationSeats(req: Request, res: Response) {
  const { seatCount } = setSeatsSchema.parse(req.body);
  await adminUserService.setOrganizationSeats(req.params.orgId, seatCount);
  void recordAdminAuditLog(req.user!.id, "organization_seats_changed", "organization", req.params.orgId, { seatCount });
  res.status(204).send();
}

const setPooledSchema = z.object({ pooledMonthlyTokens: z.number().int().min(0) });

export async function setOrganizationPooledTokens(req: Request, res: Response) {
  const { pooledMonthlyTokens } = setPooledSchema.parse(req.body);
  await adminUserService.setOrganizationPooledTokens(req.params.orgId, pooledMonthlyTokens);
  void recordAdminAuditLog(req.user!.id, "organization_pool_changed", "organization", req.params.orgId, {
    pooledMonthlyTokens,
  });
  res.status(204).send();
}

export async function profitability(req: Request, res: Response) {
  const sinceDays = Math.min(365, Math.max(1, Number(req.query.sinceDays) || 30));
  res.json(await adminUserService.profitabilitySummary(sinceDays));
}
