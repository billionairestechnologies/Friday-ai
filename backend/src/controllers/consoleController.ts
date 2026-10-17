import type { Request, Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { recordAdminAuditLog } from "../services/usageService.js";
import { PERMISSIONS } from "../services/console/permissions.js";
import { searchUsers } from "../services/console/directory.js";
import * as team from "../services/console/teamService.js";
import * as updates from "../services/console/announcementService.js";
import * as campaigns from "../services/console/campaignService.js";
import * as crm from "../services/console/crmService.js";
import * as support from "../services/console/supportService.js";
import * as tasks from "../services/console/taskService.js";
import * as overviewService from "../services/console/overviewService.js";
import { setUserPlan } from "../services/adminUserService.js";
import { mailConfigured } from "../services/console/mail.js";
import { revokeOthers } from "../services/sessions/sessionService.js";

/** Team Console API (mounted at /api/console, every route permission-gated in routes/console.ts). */

const id = z.string().uuid();
const audience = z.enum(["all", "free", "paid", "pro", "premium", "new_users"]);
const optionalUrl = z.string().trim().url().max(2000).nullable().optional().or(z.literal(""));
const isoDate = z.string().datetime({ offset: true }).nullable().optional();

function audit(req: Request, action: string, targetType: string, targetId?: string, meta: Record<string, unknown> = {}) {
  void recordAdminAuditLog(req.user!.id, action, targetType, targetId, meta).catch(() => {});
}

// ── Me ──────────────────────────────────────────────────────────────────────

export async function me(req: Request, res: Response) {
  res.json({ staff: req.staff, permissionCatalog: PERMISSIONS, mailConfigured: mailConfigured() });
}

/** Teammates for assignee pickers — any staff member may read names/roles (not permissions). */
export async function staffDirectory(_req: Request, res: Response) {
  const [members, roles] = await Promise.all([team.listMembers(), team.listRoles()]);
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  res.json({
    staff: members
      .filter((m) => m.active)
      .map((m) => ({ userId: m.userId, name: m.name || m.email?.split("@")[0] || "Teammate", email: m.email, roleName: roleName.get(m.roleId) ?? (m.roleId === "owner" ? "Owner" : m.roleId) })),
  });
}

export async function overview(_req: Request, res: Response) {
  res.json(await overviewService.overview());
}

// ── Users ───────────────────────────────────────────────────────────────────

export async function listUsers(req: Request, res: Response) {
  const q = z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  res.json({ users: await searchUsers(q.q ?? null, q.limit, q.offset) });
}

export async function getUser(req: Request, res: Response) {
  res.json({ user: await overviewService.userDetail(id.parse(req.params.userId)) });
}

export async function updateUser(req: Request, res: Response) {
  const userId = id.parse(req.params.userId);
  const body = z.object({ plan: z.enum(["free", "pro", "premium"]).optional(), suspended: z.boolean().optional() }).parse(req.body);
  if (body.plan) {
    await setUserPlan(userId, body.plan);
    audit(req, "console.user.plan", "user", userId, { plan: body.plan });
  }
  if (body.suspended !== undefined) {
    if (userId === req.user!.id) throw new HttpError(400, "You can't suspend yourself");
    await overviewService.setSuspended(userId, body.suspended);
    // A suspended account's open devices stop now, not when their access tokens expire.
    if (body.suspended) await revokeOthers(userId, null, "admin").catch(() => 0);
    audit(req, body.suspended ? "console.user.suspend" : "console.user.restore", "user", userId);
  }
  res.json({ user: await overviewService.userDetail(userId) });
}

// ── Team & roles ────────────────────────────────────────────────────────────

export async function listTeam(_req: Request, res: Response) {
  const [members, roles] = await Promise.all([team.listMembers(), team.listRoles()]);
  res.json({ members, roles, permissionCatalog: PERMISSIONS });
}

export async function inviteMember(req: Request, res: Response) {
  const body = z
    .object({ email: z.string().trim().email(), name: z.string().trim().min(1).max(120), roleId: z.string().min(1), title: z.string().max(120).optional(), team: z.string().max(80).optional() })
    .parse(req.body);
  if (body.roleId === "owner" && !req.staff!.isOwner) throw new HttpError(403, "Only owners can add owners");
  const result = await team.inviteMember(body, req.user!.id);
  audit(req, "console.team.invite", "user", result.member?.userId, { email: body.email, roleId: body.roleId });
  res.status(201).json(result);
}

export async function updateMember(req: Request, res: Response) {
  const userId = id.parse(req.params.userId);
  const body = z.object({ roleId: z.string().min(1).optional(), title: z.string().max(120).optional(), team: z.string().max(80).optional(), active: z.boolean().optional() }).parse(req.body);
  await team.updateMember(userId, body, req.user!.id);
  audit(req, "console.team.update", "user", userId, body);
  res.json({ ok: true });
}

export async function removeMember(req: Request, res: Response) {
  const userId = id.parse(req.params.userId);
  await team.removeMember(userId, req.user!.id);
  audit(req, "console.team.remove", "user", userId);
  res.status(204).end();
}

export async function saveRole(req: Request, res: Response) {
  const body = z
    .object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(), name: z.string().trim().min(1).max(60), description: z.string().max(300).optional(), permissions: z.array(z.string()).max(100) })
    .parse(req.body);
  const role = await team.saveRole(body);
  audit(req, "console.role.save", "role", role.id, { permissions: role.permissions });
  res.json({ role });
}

export async function deleteRole(req: Request, res: Response) {
  await team.deleteRole(z.string().min(1).parse(req.params.roleId));
  audit(req, "console.role.delete", "role", req.params.roleId);
  res.status(204).end();
}

// ── Mail identities ─────────────────────────────────────────────────────────

export async function listMail(_req: Request, res: Response) {
  res.json({ identities: await team.listMailIdentities(), configured: mailConfigured() });
}

export async function saveMail(req: Request, res: Response) {
  const body = z
    .object({
      id: id.optional(),
      address: z.string().trim().email(),
      displayName: z.string().trim().min(1).max(80),
      team: z.string().max(80).optional(),
      purpose: z.enum(["general", "support", "marketing", "sales"]),
      isDefault: z.boolean().optional(),
    })
    .parse(req.body);
  res.json({ identity: await team.saveMailIdentity(body) });
}

export async function deleteMail(req: Request, res: Response) {
  await team.deleteMailIdentity(id.parse(req.params.identityId));
  res.status(204).end();
}

// ── Product updates ─────────────────────────────────────────────────────────

const announcementSchema = z.object({
  title: z.string().trim().min(1).max(140),
  body: z.string().max(8000).default(""),
  imageUrl: optionalUrl,
  ctaLabel: z.string().max(40).nullable().optional(),
  // CTA links: in-app paths ("/plans") or https — checked by announcementService.safeCtaUrl.
  ctaUrl: z.string().trim().max(500).nullable().optional(),
  cta2Label: z.string().max(40).nullable().optional(),
  cta2Url: z.string().trim().max(500).nullable().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  variant: z.enum(["modal", "banner"]).optional(),
  accent: z.enum(["default", "blue", "green", "amber", "purple", "red"]).optional(),
  icon: z.enum(["sparkles", "rocket", "gift", "wrench", "shield", "megaphone", "graduation"]).optional(),
  kind: z.enum(["feature", "improvement", "news", "maintenance"]).default("feature"),
  audience: audience.default("all"),
  platforms: z.array(z.enum(["web", "android", "ios"])).min(1).default(["web", "android", "ios"]),
  publishAt: isoDate,
  expiresAt: isoDate,
});

export async function listUpdates(_req: Request, res: Response) {
  res.json({ updates: await updates.listAnnouncements() });
}

export async function createUpdate(req: Request, res: Response) {
  const body = announcementSchema.parse(req.body);
  const row = await updates.createAnnouncement({ ...body, imageUrl: body.imageUrl || null, ctaUrl: body.ctaUrl || null }, req.user!.id);
  audit(req, "console.update.create", "announcement", row.id as string);
  res.status(201).json({ update: row });
}

export async function editUpdate(req: Request, res: Response) {
  const body = announcementSchema.partial().parse(req.body);
  res.json({ update: await updates.updateAnnouncement(id.parse(req.params.updateId), { ...body, imageUrl: body.imageUrl === "" ? null : body.imageUrl, ctaUrl: body.ctaUrl === "" ? null : body.ctaUrl }) });
}

export async function setUpdateStatus(req: Request, res: Response) {
  const { status } = z.object({ status: z.enum(["draft", "published", "archived"]) }).parse(req.body);
  const row = await updates.setAnnouncementStatus(id.parse(req.params.updateId), status);
  audit(req, `console.update.${status}`, "announcement", row.id as string);
  res.json({ update: row });
}

/** "Show it again": a published update becomes a new version that its audience sees once more. */
export async function republishUpdate(req: Request, res: Response) {
  const row = await updates.publishNewVersion(id.parse(req.params.updateId));
  audit(req, "console.update.new_version", "announcement", row.id as string, { version: row.version });
  res.json({ update: row });
}

export async function deleteUpdate(req: Request, res: Response) {
  await updates.deleteAnnouncement(id.parse(req.params.updateId));
  res.status(204).end();
}

/** "Also email this update": a draft campaign pre-filled from the update, opened in the composer. */
export async function campaignFromUpdate(req: Request, res: Response) {
  const updateId = id.parse(req.params.updateId);
  const { data: a } = await supabaseAdmin.from("announcements").select("*").eq("id", updateId).maybeSingle();
  if (!a) throw new HttpError(404, "Update not found");
  const campaign = await campaigns.createCampaign(
    {
      name: `Update: ${a.title}`,
      subject: a.title as string,
      preheader: "",
      bodyMarkdown: `Hi {{first_name}},\n\n# ${a.title}\n\n${a.body}`,
      ctaLabel: (a.cta_label as string | null) ?? "Try it now",
      ctaUrl: (a.cta_url as string | null) ?? null,
      audience: a.audience as "all",
      announcementId: updateId,
    },
    req.user!.id,
  );
  res.status(201).json({ campaign });
}

// ── Campaigns ───────────────────────────────────────────────────────────────

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(140),
  subject: z.string().trim().max(200).default(""),
  preheader: z.string().max(200).optional(),
  bodyMarkdown: z.string().max(50_000).default(""),
  ctaLabel: z.string().max(40).nullable().optional(),
  ctaUrl: optionalUrl,
  audience: audience.default("all"),
  fromIdentityId: id.nullable().optional(),
  announcementId: id.nullable().optional(),
});

export async function listCampaigns(_req: Request, res: Response) {
  res.json({ campaigns: await campaigns.listCampaigns() });
}

export async function createCampaign(req: Request, res: Response) {
  const body = campaignSchema.parse(req.body);
  const row = await campaigns.createCampaign({ ...body, ctaUrl: body.ctaUrl || null }, req.user!.id);
  audit(req, "console.campaign.create", "campaign", row.id as string);
  res.status(201).json({ campaign: row });
}

export async function editCampaign(req: Request, res: Response) {
  const body = campaignSchema.partial().parse(req.body);
  res.json({ campaign: await campaigns.updateCampaign(id.parse(req.params.campaignId), { ...body, ctaUrl: body.ctaUrl === "" ? null : body.ctaUrl }) });
}

export async function deleteCampaign(req: Request, res: Response) {
  await campaigns.deleteCampaign(id.parse(req.params.campaignId));
  res.status(204).end();
}

export async function audienceCount(req: Request, res: Response) {
  const q = z.object({ audience }).parse(req.query);
  res.json({ count: await campaigns.countAudience(q.audience) });
}

export async function testCampaign(req: Request, res: Response) {
  const { to } = z.object({ to: z.string().trim().email().optional() }).parse(req.body ?? {});
  const target = to ?? req.user!.email;
  if (!target) throw new HttpError(400, "No email address to send the test to");
  await campaigns.sendTest(id.parse(req.params.campaignId), target, req.user!.name, req.user!.id);
  res.json({ ok: true, to: target });
}

export async function sendCampaign(req: Request, res: Response) {
  const { scheduledAt } = z.object({ scheduledAt: isoDate }).parse(req.body ?? {});
  const row = await campaigns.scheduleCampaign(id.parse(req.params.campaignId), scheduledAt ?? null);
  audit(req, scheduledAt ? "console.campaign.schedule" : "console.campaign.send", "campaign", row.id as string, { audience: row.audience, scheduledAt });
  res.json({ campaign: row });
}

export async function cancelCampaign(req: Request, res: Response) {
  res.json({ campaign: await campaigns.cancelSchedule(id.parse(req.params.campaignId)) });
}

// ── CRM ─────────────────────────────────────────────────────────────────────

const contactSchema = z.object({
  kind: z.enum(["lead", "client"]).optional(),
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().nullable().optional().or(z.literal("")),
  phone: z.string().max(40).nullable().optional(),
  company: z.string().max(160).nullable().optional(),
  source: z.string().max(80).optional(),
  stageId: z.string().min(1).optional(),
  ownerId: id.nullable().optional(),
  value: z.coerce.number().min(0).max(1e12).optional(),
  currency: z.string().length(3).optional(),
  tags: z.array(z.string().max(40)).max(30).optional(),
  notes: z.string().max(10_000).optional(),
});

export async function crmBoard(req: Request, res: Response) {
  const q = z.object({ q: z.string().max(200).optional(), kind: z.enum(["lead", "client"]).optional(), stageId: z.string().optional(), ownerId: id.optional() }).parse(req.query);
  const [stages, contacts, summary] = await Promise.all([crm.listStages(), crm.listContacts(q), crm.pipelineSummary()]);
  res.json({ stages, contacts, summary });
}

export async function createContact(req: Request, res: Response) {
  const body = contactSchema.parse(req.body);
  res.status(201).json({ contact: await crm.createContact({ ...body, email: body.email || null }, req.user!.id) });
}

export async function getContact(req: Request, res: Response) {
  res.json({ contact: await crm.getContact(id.parse(req.params.contactId)) });
}

export async function updateContact(req: Request, res: Response) {
  const body = contactSchema.partial().parse(req.body);
  res.json({ contact: await crm.updateContact(id.parse(req.params.contactId), { ...body, email: body.email === "" ? null : body.email }, req.user!.id) });
}

export async function deleteContact(req: Request, res: Response) {
  await crm.deleteContact(id.parse(req.params.contactId));
  audit(req, "console.crm.delete", "contact", req.params.contactId);
  res.status(204).end();
}

export async function addContactActivity(req: Request, res: Response) {
  const body = z.object({ kind: z.enum(["note", "call", "email", "meeting"]), body: z.string().trim().min(1).max(10_000) }).parse(req.body);
  res.status(201).json({ activity: await crm.addActivity(id.parse(req.params.contactId), body, req.user!.id) });
}

export async function saveStage(req: Request, res: Response) {
  const body = z
    .object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), name: z.string().trim().min(1).max(60), position: z.number().int().min(0).max(100), outcome: z.enum(["open", "won", "lost"]), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) })
    .parse(req.body);
  res.json({ stage: await crm.saveStage(body) });
}

export async function deleteStage(req: Request, res: Response) {
  await crm.deleteStage(z.string().min(1).parse(req.params.stageId));
  res.status(204).end();
}

// ── Support ─────────────────────────────────────────────────────────────────

export async function listTickets(req: Request, res: Response) {
  const q = z
    .object({ status: z.enum(["active", "open", "pending", "resolved", "closed"]).optional(), assignee: z.string().optional(), q: z.string().max(200).optional() })
    .parse(req.query);
  const [tickets, stats] = await Promise.all([
    support.listTickets({
      status: q.status,
      q: q.q,
      assigneeId: q.assignee === "me" ? req.user!.id : q.assignee && q.assignee !== "none" ? q.assignee : undefined,
      unassigned: q.assignee === "none",
    }),
    support.supportStats(),
  ]);
  res.json({ tickets, stats });
}

export async function getTicket(req: Request, res: Response) {
  res.json({ ticket: await support.getTicket(id.parse(req.params.ticketId)) });
}

export async function replyTicket(req: Request, res: Response) {
  const body = z.object({ body: z.string().trim().min(1).max(20_000), internal: z.boolean().default(false) }).parse(req.body);
  await support.staffReply(id.parse(req.params.ticketId), req.user!.id, body.body, body.internal);
  res.json({ ticket: await support.getTicket(req.params.ticketId!) });
}

export async function updateTicket(req: Request, res: Response) {
  const body = z
    .object({ status: z.enum(["open", "pending", "resolved", "closed"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), assigneeId: id.nullable().optional(), category: z.string().max(60).optional() })
    .parse(req.body);
  await support.updateTicket(id.parse(req.params.ticketId), body, req.user!.id);
  res.json({ ticket: await support.getTicket(req.params.ticketId!) });
}

export async function createTicketForUser(req: Request, res: Response) {
  const body = z.object({ email: z.string().trim().email(), name: z.string().max(120).default(""), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20_000) }).parse(req.body);
  const ticket = await support.createTicket({ userId: null, ...body, channel: "console" });
  res.status(201).json({ ticket });
}

// ── Tasks ───────────────────────────────────────────────────────────────────

const taskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional(),
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assigneeId: id.nullable().optional(),
  dueAt: isoDate,
  relatedType: z.enum(["ticket", "contact"]).nullable().optional(),
  relatedId: id.nullable().optional(),
});

export async function listTasks(req: Request, res: Response) {
  const q = z.object({ assignee: z.string().optional(), status: z.enum(["todo", "in_progress", "done"]).optional(), relatedId: id.optional() }).parse(req.query);
  res.json({ tasks: await tasks.listTasks({ assigneeId: q.assignee === "me" ? req.user!.id : q.assignee, status: q.status, relatedId: q.relatedId }) });
}

export async function createTask(req: Request, res: Response) {
  res.status(201).json({ task: await tasks.createTask(taskSchema.parse(req.body), req.user!.id) });
}

export async function updateTask(req: Request, res: Response) {
  res.json({ task: await tasks.updateTask(id.parse(req.params.taskId), taskSchema.partial().parse(req.body)) });
}

export async function deleteTask(req: Request, res: Response) {
  await tasks.deleteTask(id.parse(req.params.taskId));
  res.status(204).end();
}

// ── Audit ───────────────────────────────────────────────────────────────────

export async function auditLog(req: Request, res: Response) {
  const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
  const { data, error } = await supabaseAdmin.from("admin_audit_logs").select("*").order("created_at", { ascending: false }).limit(q.limit);
  if (error) throw new HttpError(500, error.message);
  res.json({ entries: data ?? [] });
}
