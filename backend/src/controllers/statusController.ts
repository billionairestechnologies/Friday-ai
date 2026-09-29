import type { Request, Response } from "express";
import { z } from "zod";
import { recordAdminAuditLog } from "../services/usageService.js";
import * as status from "../services/status/statusService.js";

/** /api/status (public) and /api/console/status/* (team). */

const id = z.string().uuid();
const incidentStatus = z.enum(["investigating", "identified", "monitoring", "resolved"]);
const impact = z.enum(["none", "minor", "major", "critical"]);

export async function publicStatus(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "public, max-age=30");
  res.json(await status.getPublicStatus());
}

const reportSchema = z.object({
  email: z.string().trim().email().max(200).optional(),
  name: z.string().trim().max(120).optional(),
  description: z.string().trim().min(10, "Tell us a little more about what happened").max(5000),
  component: z.string().trim().max(80).nullable().optional(),
  url: z.string().trim().max(500).nullable().optional(),
});

export async function report(req: Request, res: Response) {
  const body = reportSchema.parse(req.body);
  const email = req.user?.email ?? body.email;
  if (!email) {
    res.status(400).json({ error: "Add your email so we can follow up" });
    return;
  }
  const ticket = await status.submitProblemReport({
    userId: req.user?.id ?? null,
    email,
    name: req.user?.name ?? body.name ?? email.split("@")[0]!,
    description: body.description,
    component: body.component ?? null,
    url: body.url ?? null,
    userAgent: req.header("user-agent") ?? null,
  });
  res.status(201).json({ ok: true, ticketNumber: (ticket as { number?: number }).number ?? null });
}

const crashSchema = z.object({
  platform: z.enum(["web", "android", "ios"]).default("web"),
  message: z.string().trim().min(1).max(2000),
  stack: z.string().max(20_000).nullable().optional(),
  url: z.string().max(1000).nullable().optional(),
  release: z.string().max(60).nullable().optional(),
});

export async function crash(req: Request, res: Response) {
  const body = crashSchema.parse(req.body);
  const result = await status.recordCrash({ ...body, userAgent: req.header("user-agent") ?? null, userId: req.user?.id ?? null });
  res.status(201).json(result);
}

// ── Console ──────────────────────────────────────────────────────────────────

function audit(req: Request, action: string, targetId?: string, meta: Record<string, unknown> = {}) {
  void recordAdminAuditLog(req.user!.id, action, "status", targetId, meta).catch(() => {});
}

export async function consoleOverview(_req: Request, res: Response) {
  const [publicView, incidents, crashes] = await Promise.all([status.getPublicStatus(), status.listIncidents(90), status.crashGroups(14).catch(() => [])]);
  res.json({ status: publicView, incidents, crashes });
}

const incidentSchema = z.object({
  title: z.string().trim().min(3).max(160),
  status: incidentStatus,
  impact,
  components: z.array(z.string().trim().max(80)).max(30).default([]),
  body: z.string().trim().min(3).max(5000),
  notify: z.boolean().optional(),
});

export async function createIncident(req: Request, res: Response) {
  const body = incidentSchema.parse(req.body);
  const incident = await status.createIncident(body, req.user!.id);
  audit(req, "console.status.incident.create", incident.id, { impact: body.impact });
  if (body.notify) void status.alertTeam(`Incident: ${body.title}`, body.body);
  res.status(201).json({ incident });
}

const updateSchema = z.object({ status: incidentStatus, body: z.string().trim().min(3).max(5000), title: z.string().trim().min(3).max(160).optional(), impact: impact.optional() });

export async function updateIncident(req: Request, res: Response) {
  const incidentId = id.parse(req.params.incidentId);
  const body = updateSchema.parse(req.body);
  await status.addIncidentUpdate(incidentId, body, req.user!.id);
  audit(req, "console.status.incident.update", incidentId, { status: body.status });
  res.json({ ok: true });
}

export async function deleteIncident(req: Request, res: Response) {
  const incidentId = id.parse(req.params.incidentId);
  await status.deleteIncident(incidentId);
  audit(req, "console.status.incident.delete", incidentId);
  res.json({ ok: true });
}

export async function runChecks(req: Request, res: Response) {
  const results = await status.runProbes();
  audit(req, "console.status.probe");
  res.json({ results });
}

export async function crashDetail(req: Request, res: Response) {
  res.json({ crash: await status.crashSample(id.parse(req.params.crashId)) });
}
