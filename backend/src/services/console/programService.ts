import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { logger } from "../../utils/logger.js";
import { notifyUser } from "../pushService.js";
import { announceGrant } from "../quota/credits.js";
import { quotaRpc } from "../quota/tokenQuotaService.js";
import { userLabels } from "./directory.js";
import { applyPackage, grantAccess } from "./plansService.js";

/**
 * Student / startup / company programmes (supabase 0061). A person applies with a short form and
 * optional evidence; a teammate approves, rejects or asks for more; approval grants the programme's
 * benefit (a plan for N days, a package, or bonus credits) and is valid until a re-verification date.
 *
 * Decisions go through program_decide (exactly once, even with two reviewers clicking). The benefit
 * is applied AFTER the decision commits; if that fails the application stays approved with the
 * error recorded and "Apply benefit again" retries it (credits are keyed per application, so a retry
 * can't double them).
 */

export const PROGRAMS = ["student", "startup", "company"] as const;
export type Program = (typeof PROGRAMS)[number];

const year = z.coerce.number().int().min(1990).max(2100);
// http(s) only: zod's url() accepts javascript: — and reviewers click these links.
const url = z.string().trim().url().max(300).refine((u) => /^https?:\/\//i.test(u), "Use an http(s) address");

/** The form each programme asks for. Unknown keys are dropped. */
export const DETAILS: Record<Program, z.ZodType<Record<string, unknown>>> = {
  student: z.object({
    institution: z.string().trim().min(2).max(200),
    course: z.string().trim().min(2).max(200),
    graduationYear: year,
    studentId: z.string().trim().max(100).optional(),
    country: z.string().trim().max(80).optional(),
  }),
  startup: z.object({
    companyName: z.string().trim().min(2).max(200),
    website: url,
    description: z.string().trim().min(20).max(2000),
    teamSize: z.coerce.number().int().min(1).max(10_000),
    stage: z.enum(["idea", "pre-seed", "seed", "series-a", "later"]),
    contactRole: z.string().trim().min(2).max(100),
    founded: year.optional(),
  }),
  company: z.object({
    companyName: z.string().trim().min(2).max(200),
    website: url,
    teamSize: z.coerce.number().int().min(1).max(1_000_000),
    seatsNeeded: z.coerce.number().int().min(1).max(100_000),
    useCase: z.string().trim().min(10).max(2000),
    contactRole: z.string().trim().min(2).max(100),
    phone: z.string().trim().max(40).optional(),
  }),
};

// ── Evidence files ───────────────────────────────────────────────────────────

const BUCKET = "program-evidence";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;

/** The file's real type from its first bytes — the name and the browser's MIME are never trusted. */
export function sniffEvidence(bytes: Uint8Array): { mime: string; ext: string } | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return { mime: "application/pdf", ext: "pdf" };
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png" };
  if (starts([0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return { mime: "image/webp", ext: "webp" };
  return null;
}

export type EvidenceUpload = { name: string; dataUrl: string };
export type Evidence = { id: string; name: string; mime: string; size: number; path: string };

export function decodeEvidence(file: EvidenceUpload): { bytes: Buffer; mime: string; ext: string; name: string } {
  const m = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(file.dataUrl);
  if (!m) throw new HttpError(400, "Couldn't read that file — attach a PDF, PNG, JPEG or WebP.");
  const bytes = Buffer.from(m[1]!, "base64");
  if (bytes.length === 0) throw new HttpError(400, `${file.name} is empty.`);
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(400, `${file.name} is over 5 MB.`);
  const kind = sniffEvidence(bytes);
  if (!kind) throw new HttpError(400, `${file.name} isn't a PDF, PNG, JPEG or WebP file.`);
  // Display name only: strip any path, control characters, and keep it short.
  const name = file.name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f]/g, "").slice(0, 120) || `evidence.${kind.ext}`;
  return { bytes, mime: kind.mime, ext: kind.ext, name };
}

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { error } = await supabaseAdmin.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_FILE_BYTES });
  if (error && !/exist/i.test(error.message)) throw new Error(error.message);
  bucketReady = true;
}

async function storeEvidence(userId: string, applicationId: string, files: EvidenceUpload[]): Promise<Evidence[]> {
  if (files.length > MAX_FILES) throw new HttpError(400, `Attach at most ${MAX_FILES} files.`);
  const decoded = files.map(decodeEvidence); // validate everything before storing anything
  if (!decoded.length) return [];
  await ensureBucket();
  const out: Evidence[] = [];
  for (const f of decoded) {
    const id = randomUUID();
    // Server-built path: user / application / random id — nothing from the client reaches it.
    const path = `${userId}/${applicationId}/${id}.${f.ext}`;
    const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, f.bytes, { contentType: f.mime, upsert: false });
    if (error) throw new HttpError(500, "Couldn't store the file — please try again.");
    out.push({ id, name: f.name, mime: f.mime, size: f.bytes.length, path });
  }
  return out;
}

// ── Settings ─────────────────────────────────────────────────────────────────

export type ProgramSettings = {
  id: Program;
  enabled: boolean;
  title: string;
  description: string;
  benefit_kind: "plan_grant" | "package" | "credits";
  plan: "pro" | "premium" | null;
  package_id: string | null;
  duration_days: number | null;
  credit_tokens: number | null;
  credit_days: number | null;
  valid_days: number;
};

export async function listPrograms(): Promise<ProgramSettings[]> {
  const { data, error } = await supabaseAdmin.from("program_settings").select("*").order("id");
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).map((p) => ({ ...p, credit_tokens: p.credit_tokens == null ? null : Number(p.credit_tokens) })) as ProgramSettings[];
}

export async function saveProgram(id: Program, patch: Partial<Omit<ProgramSettings, "id">>, actorId: string) {
  if (patch.benefit_kind === "plan_grant" && !patch.plan) throw new HttpError(400, "Pick the plan approval grants");
  if (patch.benefit_kind === "package" && !patch.package_id && id !== "company") throw new HttpError(400, "Pick the package approval grants");
  if (patch.benefit_kind === "credits" && !(patch.credit_tokens && patch.credit_tokens > 0)) throw new HttpError(400, "Set the bonus tokens approval grants");
  const { data, error } = await supabaseAdmin.from("program_settings").update({ ...patch, updated_by: actorId, updated_at: new Date().toISOString() }).eq("id", id).select().single();
  if (error || !data) throw new HttpError(400, error?.message ?? "Couldn't save the programme");
  return data;
}

// ── The applicant ────────────────────────────────────────────────────────────

export async function applyToProgram(userId: string, program: Program, rawDetails: unknown, files: EvidenceUpload[]) {
  const settings = (await listPrograms()).find((p) => p.id === program);
  if (!settings?.enabled) throw new HttpError(404, "That programme isn't open right now.");
  const parsed = DETAILS[program].safeParse(rawDetails);
  if (!parsed.success) throw new HttpError(400, `Please check the form: ${parsed.error.issues.map((i) => i.path.join(".") || "form").join(", ")}`);
  const id = randomUUID();
  const evidence = await storeEvidence(userId, id, files);
  const { data, error } = await supabaseAdmin
    .from("program_applications")
    .insert({ id, user_id: userId, program, details: parsed.data, evidence })
    .select("id, program, status, created_at")
    .single();
  if (error) {
    if (evidence.length) await supabaseAdmin.storage.from(BUCKET).remove(evidence.map((e) => e.path)).catch(() => undefined);
    if (/duplicate|open_idx/i.test(error.message)) throw new HttpError(409, "You already have an application in review for this programme.");
    throw new HttpError(500, error.message);
  }
  return data;
}

/** Answers a "needs more information" request: updated form and/or more files → back in the queue. */
export async function respondToRequest(userId: string, applicationId: string, rawDetails: unknown | undefined, files: EvidenceUpload[]) {
  const { data: app } = await supabaseAdmin.from("program_applications").select("*").eq("id", applicationId).eq("user_id", userId).maybeSingle();
  if (!app) throw new HttpError(404, "Application not found");
  if (app.status !== "needs_info") throw new HttpError(409, "This application isn't waiting for more information.");
  const details = rawDetails === undefined ? app.details : DETAILS[app.program as Program].parse(rawDetails);
  const existing = (app.evidence as Evidence[]) ?? [];
  if (existing.length + files.length > MAX_FILES * 2) throw new HttpError(400, "That's too many files for one application.");
  const added = await storeEvidence(userId, applicationId, files);
  const { error } = await supabaseAdmin
    .from("program_applications")
    .update({ details, evidence: [...existing, ...added], status: "submitted", updated_at: new Date().toISOString() })
    .eq("id", applicationId)
    .eq("status", "needs_info");
  if (error) throw new HttpError(500, error.message);
  return { ok: true };
}

export async function withdrawApplication(userId: string, applicationId: string) {
  const { data } = await supabaseAdmin
    .from("program_applications")
    .update({ status: "withdrawn", updated_at: new Date().toISOString() })
    .eq("id", applicationId)
    .eq("user_id", userId)
    .in("status", ["submitted", "needs_info"])
    .select("id")
    .maybeSingle();
  if (!data) throw new HttpError(409, "Only an application still in review can be withdrawn.");
  return { ok: true };
}

/** What the person sees: their applications (no storage paths, no reviewer identity). */
export async function myApplications(userId: string) {
  const [programs, apps] = await Promise.all([
    listPrograms(),
    supabaseAdmin.from("program_applications").select("id, program, status, details, evidence, info_request, decision_note, valid_until, created_at, updated_at").eq("user_id", userId).order("created_at", { ascending: false }),
  ]);
  return {
    programs: programs.filter((p) => p.enabled).map((p) => ({ id: p.id, title: p.title, description: p.description })),
    applications: (apps.data ?? []).map((a) => ({ ...a, evidence: ((a.evidence as Evidence[]) ?? []).map((e) => ({ id: e.id, name: e.name, size: e.size })) })),
  };
}

// ── Review ───────────────────────────────────────────────────────────────────

export async function listApplications(filter: { status?: string; program?: string } = {}) {
  let q = supabaseAdmin.from("program_applications").select("*").order("created_at", { ascending: false }).limit(300);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.program) q = q.eq("program", filter.program);
  const { data, error } = await q;
  if (error) throw new HttpError(500, error.message);
  const labels = await userLabels((data ?? []).map((a) => a.user_id as string));
  return (data ?? []).map((a) => ({
    ...a,
    user: labels[a.user_id as string] ?? null,
    // The console gets file ids + names; the bytes only via a short-lived signed link (evidenceLink).
    evidence: ((a.evidence as Evidence[]) ?? []).map((e) => ({ id: e.id, name: e.name, mime: e.mime, size: e.size })),
  }));
}

export async function evidenceLink(applicationId: string, fileId: string): Promise<string> {
  const { data: app } = await supabaseAdmin.from("program_applications").select("evidence").eq("id", applicationId).maybeSingle();
  const file = ((app?.evidence as Evidence[]) ?? []).find((e) => e.id === fileId);
  if (!file) throw new HttpError(404, "File not found");
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(file.path, 300);
  if (error || !data?.signedUrl) throw new HttpError(500, "Couldn't open the file");
  return data.signedUrl;
}

export type BenefitOverride = { kind: "plan_grant"; plan: "pro" | "premium"; durationDays: number | null } | { kind: "package"; packageId: string } | { kind: "credits"; tokens: number; days: number | null };

function resolveBenefit(settings: ProgramSettings, override: BenefitOverride | null): BenefitOverride {
  if (override) return override;
  if (settings.benefit_kind === "plan_grant") return { kind: "plan_grant", plan: settings.plan ?? "pro", durationDays: settings.duration_days };
  if (settings.benefit_kind === "package") {
    if (!settings.package_id) throw new HttpError(400, "This programme has no default package — choose what to grant for this application.");
    return { kind: "package", packageId: settings.package_id };
  }
  return { kind: "credits", tokens: settings.credit_tokens ?? 0, days: settings.credit_days };
}

async function grantBenefit(applicationId: string, userId: string, title: string, b: BenefitOverride, actorId: string): Promise<Record<string, unknown>> {
  if (b.kind === "credits") {
    if (!(b.tokens > 0)) throw new HttpError(400, "Set the bonus tokens to grant.");
    const expiresAt = b.days ? new Date(Date.now() + b.days * 86_400_000).toISOString() : null;
    const row = await quotaRpc<Record<string, unknown>>("quota_grant_credits", {
      p_user: userId, p_org: null, p_tokens: b.tokens, p_expires_at: expiresAt, p_kind: "program", p_reason: title,
      p_actor: actorId, p_key: `program:${applicationId}`, p_requires_approval: false, p_source: "program",
    });
    if (!row.duplicate) await announceGrant(userId, String(row.grant_id), b.tokens, expiresAt);
    return { kind: "credits", grantId: row.grant_id, tokens: b.tokens, expiresAt };
  }
  const grant =
    b.kind === "package"
      ? await applyPackage(b.packageId, { userId }, title, actorId)
      : await grantAccess({ userId, plan: b.plan, durationDays: b.durationDays, source: "manual", note: title }, actorId);
  return { kind: b.kind, grantId: grant.id, plan: grant.plan, endsAt: grant.ends_at };
}

async function tell(userId: string, kind: string, title: string, body: string, dedupe: string) {
  await supabaseAdmin
    .from("user_notifications")
    .upsert({ user_id: userId, kind, title, body, data: {}, dedupe_key: dedupe }, { onConflict: "dedupe_key", ignoreDuplicates: true })
    .then(({ error }) => error && logger.error("program_notification_failed", { dedupe, error: error.message }));
  await notifyUser(userId, { title, body }).catch(() => undefined);
}

export type Decision = "approved" | "rejected" | "needs_info";

export async function decideApplication(applicationId: string, decision: Decision, note: string, actorId: string, override: BenefitOverride | null = null) {
  const { data: before } = await supabaseAdmin.from("program_applications").select("*").eq("id", applicationId).maybeSingle();
  if (!before) throw new HttpError(404, "Application not found");
  const settings = (await listPrograms()).find((p) => p.id === before.program)!;
  // Validate the benefit BEFORE deciding, so a misconfigured programme can't approve with nothing to give.
  const benefit = decision === "approved" ? resolveBenefit(settings, override) : null;
  const validUntil = decision === "approved" ? new Date(Date.now() + settings.valid_days * 86_400_000).toISOString() : null;
  let row: Record<string, unknown>;
  try {
    // PostgREST returns a single composite as an object; a raw pg driver as a one-row array.
    const out = await quotaRpc<Record<string, unknown> | Record<string, unknown>[]>("program_decide", { p_application: applicationId, p_status: decision, p_actor: actorId, p_note: note, p_valid_until: validUntil });
    row = (Array.isArray(out) ? out[0] : out) ?? {};
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (m.includes("application_not_open")) throw new HttpError(409, "Someone already decided this application.");
    throw err;
  }
  const userId = before.user_id as string;
  if (decision === "needs_info") {
    await tell(userId, "program_needs_info", `About your ${settings.title} application`, note, `program:${applicationId}:info:${Date.now()}`);
    return { status: "needs_info" as const, row };
  }
  if (decision === "rejected") {
    await tell(userId, "program_rejected", `About your ${settings.title} application`, note || "We couldn't approve it this time.", `program:${applicationId}:rejected`);
    return { status: "rejected" as const, row };
  }
  return { status: "approved" as const, ...(await applyApprovedBenefit(applicationId, userId, settings, benefit!, actorId)) };
}

async function applyApprovedBenefit(applicationId: string, userId: string, settings: ProgramSettings, benefit: BenefitOverride, actorId: string) {
  try {
    const given = await grantBenefit(applicationId, userId, settings.title, benefit, actorId);
    await supabaseAdmin.from("program_applications").update({ benefit: given, benefit_override: benefit, updated_at: new Date().toISOString() }).eq("id", applicationId);
    await tell(userId, "program_approved", `You're in the ${settings.title}`, "Your benefits are active on your account now.", `program:${applicationId}:approved`);
    return { benefit: given };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabaseAdmin.from("program_applications").update({ benefit: { error: message }, benefit_override: benefit }).eq("id", applicationId);
    logger.error("program_benefit_failed", { applicationId, error: message });
    throw new HttpError(502, "Approved, but applying the benefit failed — use “Apply benefit again”.");
  }
}

/** Re-applies the benefit of an approved application whose grant failed (no grant id recorded). */
export async function retryBenefit(applicationId: string, actorId: string) {
  const { data: app } = await supabaseAdmin.from("program_applications").select("*").eq("id", applicationId).maybeSingle();
  if (!app || app.status !== "approved") throw new HttpError(409, "Only an approved application can be retried.");
  if ((app.benefit as Record<string, unknown>)?.grantId) throw new HttpError(409, "The benefit is already applied.");
  const settings = (await listPrograms()).find((p) => p.id === app.program)!;
  return applyApprovedBenefit(applicationId, app.user_id as string, settings, (app.benefit_override as BenefitOverride | null) ?? resolveBenefit(settings, null), actorId);
}

/** Approved applications past their re-verification date → expired, and the person is told to renew. */
export async function expireApplications(now = new Date()): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("program_applications")
    .update({ status: "expired", updated_at: now.toISOString() })
    .eq("status", "approved")
    .lt("valid_until", now.toISOString())
    .select("id, user_id, program");
  if (error) {
    logger.error("program_expiry_failed", { error: error.message });
    return 0;
  }
  for (const a of data ?? []) {
    await tell(a.user_id as string, "program_renew", "Time to re-verify", "Your programme membership has ended — apply again from Help & support to renew.", `program:${a.id}:expired`);
  }
  return (data ?? []).length;
}
