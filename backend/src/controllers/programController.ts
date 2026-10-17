import type { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../utils/logger.js";
import { recordAdminAuditLog } from "../services/usageService.js";
import * as programs from "../services/console/programService.js";

/** /api/programs (the applicant) + /api/console/programs (review and settings). */

const program = z.enum(programs.PROGRAMS);
const files = z.array(z.object({ name: z.string().max(300), dataUrl: z.string().max(7_500_000) })).max(3).default([]);
const id = z.string().uuid();

async function audit(req: Request, action: string, targetId: string, meta: Record<string, unknown>) {
  await recordAdminAuditLog(req.user!.id, action, "program_application", targetId, { ...meta, correlation_id: req.requestId ?? null }).catch((err) =>
    logger.error("program_audit_failed", { action, error: err instanceof Error ? err.message : String(err) }),
  );
}

export async function mine(req: Request, res: Response) {
  res.json(await programs.myApplications(req.user!.id));
}

export async function apply(req: Request, res: Response) {
  const body = z.object({ program, details: z.record(z.unknown()), files }).parse(req.body);
  res.status(201).json(await programs.applyToProgram(req.user!.id, body.program, body.details, body.files));
}

export async function respond(req: Request, res: Response) {
  const body = z.object({ details: z.record(z.unknown()).optional(), files }).parse(req.body);
  res.json(await programs.respondToRequest(req.user!.id, id.parse(req.params.applicationId), body.details, body.files));
}

export async function withdraw(req: Request, res: Response) {
  res.json(await programs.withdrawApplication(req.user!.id, id.parse(req.params.applicationId)));
}

export async function consoleOverview(req: Request, res: Response) {
  const q = z.object({ status: z.enum(["submitted", "needs_info", "approved", "rejected", "withdrawn", "expired"]).optional(), program: program.optional() }).parse(req.query);
  const [settings, applications] = await Promise.all([programs.listPrograms(), programs.listApplications(q)]);
  res.json({ settings, applications });
}

const override = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("plan_grant"), plan: z.enum(["pro", "premium"]), durationDays: z.number().int().positive().max(3650).nullable() }),
    z.object({ kind: z.literal("package"), packageId: id }),
    z.object({ kind: z.literal("credits"), tokens: z.number().int().positive().max(1_000_000_000), days: z.number().int().positive().max(3650).nullable() }),
  ])
  .nullable()
  .default(null);

export async function decide(req: Request, res: Response) {
  const appId = id.parse(req.params.applicationId);
  const body = z
    .object({ decision: z.enum(["approved", "rejected", "needs_info"]), note: z.string().trim().max(2000).default(""), override })
    .refine((b) => b.decision !== "needs_info" || b.note.length >= 5, "Say what information you need")
    .parse(req.body);
  const result = await programs.decideApplication(appId, body.decision, body.note, req.user!.id, body.override);
  await audit(req, `program_${body.decision}`, appId, { note: body.note, override: body.override });
  res.json(result);
}

export async function retry(req: Request, res: Response) {
  const appId = id.parse(req.params.applicationId);
  const result = await programs.retryBenefit(appId, req.user!.id);
  await audit(req, "program_benefit_retried", appId, {});
  res.json(result);
}

export async function evidence(req: Request, res: Response) {
  const url = await programs.evidenceLink(id.parse(req.params.applicationId), id.parse(req.params.fileId));
  await audit(req, "program_evidence_viewed", req.params.applicationId!, { fileId: req.params.fileId });
  res.json({ url });
}

export async function saveSettings(req: Request, res: Response) {
  const which = program.parse(req.params.program);
  const body = z
    .object({
      enabled: z.boolean(),
      title: z.string().trim().min(2).max(120),
      description: z.string().trim().max(1000),
      benefit_kind: z.enum(["plan_grant", "package", "credits"]),
      plan: z.enum(["pro", "premium"]).nullable(),
      package_id: id.nullable(),
      duration_days: z.number().int().positive().max(3650).nullable(),
      credit_tokens: z.number().int().positive().max(1_000_000_000).nullable(),
      credit_days: z.number().int().positive().max(3650).nullable(),
      valid_days: z.number().int().positive().max(3650),
    })
    .parse(req.body);
  const saved = await programs.saveProgram(which, body, req.user!.id);
  await audit(req, "program_settings_changed", which, body);
  res.json(saved);
}
