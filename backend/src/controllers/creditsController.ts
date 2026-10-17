import type { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../utils/logger.js";
import { recordAdminAuditLog } from "../services/usageService.js";
import {
  approveBatch,
  approveGrant,
  creditSummary,
  getCreditSettings,
  GRANT_KINDS,
  grantBulk,
  grantCredits,
  listGrants,
  myCredits,
  previewBulk,
  rejectBatch,
  revokeGrant,
  saveCreditSettings,
} from "../services/quota/credits.js";

/** Console → Credits (supabase 0060, services/quota/credits.ts) + the user's own credit list. */

async function audit(req: Request, action: string, targetId: string, meta: Record<string, unknown>) {
  await recordAdminAuditLog(req.user!.id, action, "credit_grant", targetId, { ...meta, correlation_id: req.requestId ?? null }).catch((err) =>
    logger.error("credit_audit_failed", { action, targetId, error: err instanceof Error ? err.message : String(err) }),
  );
}

const tokens = z.number().int().positive().max(1_000_000_000_000);
const expiresAt = z.string().datetime({ offset: true }).nullable();
const kind = z.enum(GRANT_KINDS);
const reason = z.string().trim().min(3).max(500);
const audience = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("plans"), plans: z.array(z.enum(["free", "pro", "premium", "enterprise"])).min(1) }),
  z.object({ kind: z.literal("emails"), emails: z.array(z.string().trim().email().max(320)).min(1).max(10_000) }),
  z.object({ kind: z.literal("signed_up"), from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }),
]);

export async function overview(_req: Request, res: Response) {
  const [summary, settings, grants] = await Promise.all([creditSummary(), getCreditSettings(), listGrants({ limit: 200 })]);
  res.json({ summary, settings, grants });
}

export async function list(req: Request, res: Response) {
  const q = z.object({ status: z.enum(["pending", "active", "expired", "revoked", "rejected"]).optional(), userId: z.string().uuid().optional(), batchId: z.string().uuid().optional() }).parse(req.query);
  res.json({ grants: await listGrants(q) });
}

export async function grant(req: Request, res: Response) {
  const body = z
    .object({ userId: z.string().uuid().nullish(), organizationId: z.string().uuid().nullish(), tokens, expiresAt, kind, reason, key: z.string().uuid() })
    .refine((b) => Boolean(b.userId) !== Boolean(b.organizationId), "Pick exactly one: a person or an organization")
    .parse(req.body);
  const result = await grantCredits(body, req.user!.id);
  if (!result.duplicate) await audit(req, result.grantStatus === "pending" ? "credit_grant_requested" : "credit_granted", result.grantId, { userId: body.userId ?? null, organizationId: body.organizationId ?? null, tokens: body.tokens, expiresAt: body.expiresAt, kind: body.kind, reason: body.reason });
  res.status(result.duplicate ? 200 : 201).json(result);
}

export async function preview(req: Request, res: Response) {
  const body = z.object({ audience, tokens }).parse(req.body);
  res.json(await previewBulk(body.audience, body.tokens));
}

export async function bulk(req: Request, res: Response) {
  const body = z.object({ audience, tokens, expiresAt, kind, reason, batchId: z.string().uuid(), expectedCount: z.number().int().positive() }).parse(req.body);
  const result = await grantBulk(body, req.user!.id);
  await audit(req, result.status === "pending" ? "credit_bulk_requested" : "credit_bulk_granted", body.batchId, { audience: body.audience, tokens: body.tokens, expiresAt: body.expiresAt, kind: body.kind, reason: body.reason, ...result });
  res.status(201).json(result);
}

export async function approve(req: Request, res: Response) {
  const id = z.string().uuid().parse(req.params.grantId);
  const result = await approveGrant(id, req.user!.id);
  if (!result.duplicate) await audit(req, "credit_grant_approved", id, {});
  res.json(result);
}

export async function revoke(req: Request, res: Response) {
  const id = z.string().uuid().parse(req.params.grantId);
  const body = z.object({ reason }).parse(req.body);
  const result = await revokeGrant(id, req.user!.id, body.reason);
  await audit(req, result.status === "rejected" ? "credit_grant_rejected" : "credit_grant_revoked", id, { reason: body.reason, takenBack: result.takenBack });
  res.json(result);
}

export async function approveBatchRoute(req: Request, res: Response) {
  const id = z.string().uuid().parse(req.params.batchId);
  const result = await approveBatch(id, req.user!.id);
  await audit(req, "credit_bulk_approved", id, result);
  res.json(result);
}

export async function rejectBatchRoute(req: Request, res: Response) {
  const id = z.string().uuid().parse(req.params.batchId);
  const body = z.object({ reason }).parse(req.body);
  const result = await rejectBatch(id, req.user!.id, body.reason);
  await audit(req, "credit_bulk_rejected", id, { reason: body.reason, ...result });
  res.json(result);
}

export async function settings(req: Request, res: Response) {
  const body = z
    .object({
      approvalThresholdTokens: z.number().int().positive().max(1_000_000_000_000),
      maxGrantTokens: z.number().int().positive().max(1_000_000_000_000),
      bulkMaxRecipients: z.number().int().positive().max(100_000),
    })
    .parse(req.body);
  const before = await getCreditSettings();
  const saved = await saveCreditSettings(body, req.user!.id);
  await audit(req, "credit_settings_changed", "settings", { before, after: saved });
  res.json(saved);
}

/** GET /api/usage/credits — the signed-in person's own grants. */
export async function mine(req: Request, res: Response) {
  res.json(await myCredits(req.user!.id));
}
