import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { logger } from "../../utils/logger.js";
import { userLabels } from "../console/directory.js";
import { notify } from "../notificationService.js";
import { snapshotFromRow, type QuotaSnapshot } from "./allowance.js";
import { quotaRpc } from "./tokenQuotaService.js";

/**
 * Credit grants (supabase 0060): extra tokens on top of the monthly allowance that survive the
 * month and expire on their own date. The ledger functions own the balance; this module adds the
 * console rules around them — limits, approval threshold, bulk audiences, and telling the user.
 *
 *   grant ≤ approval threshold  → active at once, user notified
 *   grant > threshold           → 'pending'; someone other than its creator approves (or rejects)
 *   bulk                        → preview → execute with the previewed count (refused if the
 *                                 audience changed) → one grant per person, keyed batch:user
 */

export const GRANT_KINDS = ["promotional", "goodwill", "trial", "compensation", "campaign", "offer", "program"] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

export type CreditSettings = { approvalThresholdTokens: number; maxGrantTokens: number; bulkMaxRecipients: number };

const DEFAULT_SETTINGS: CreditSettings = { approvalThresholdTokens: 10_000_000, maxGrantTokens: 1_000_000_000, bulkMaxRecipients: 5_000 };

export async function getCreditSettings(): Promise<CreditSettings> {
  const { data, error } = await supabaseAdmin.from("credit_settings").select("*").eq("id", true).maybeSingle();
  if (error || !data) return DEFAULT_SETTINGS;
  return {
    approvalThresholdTokens: Number(data.approval_threshold_tokens),
    maxGrantTokens: Number(data.max_grant_tokens),
    bulkMaxRecipients: Number(data.bulk_max_recipients),
  };
}

export async function saveCreditSettings(next: CreditSettings, actorId: string): Promise<CreditSettings> {
  const { error } = await supabaseAdmin.from("credit_settings").upsert({
    id: true,
    approval_threshold_tokens: next.approvalThresholdTokens,
    max_grant_tokens: next.maxGrantTokens,
    bulk_max_recipients: next.bulkMaxRecipients,
    updated_by: actorId,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return next;
}

/** Pure rule, unit-tested: does this grant (or bulk batch total) need a second approver? */
export function needsApproval(totalTokens: number, settings: CreditSettings): boolean {
  return totalTokens > settings.approvalThresholdTokens;
}

export function validateGrant(input: { tokens: number; expiresAt: string | null; reason: string }, settings: CreditSettings, now = Date.now()) {
  if (!Number.isInteger(input.tokens) || input.tokens <= 0) throw new HttpError(400, "Grant a whole number of tokens above 0.");
  if (input.tokens > settings.maxGrantTokens) throw new HttpError(400, `One grant can't exceed ${settings.maxGrantTokens.toLocaleString("en-IN")} tokens.`);
  if (input.expiresAt) {
    const t = Date.parse(input.expiresAt);
    if (Number.isNaN(t)) throw new HttpError(400, "Invalid expiry date.");
    if (t <= now + 60_000) throw new HttpError(400, "The expiry must be in the future.");
  }
  if (input.reason.trim().length < 3) throw new HttpError(400, "Say why — it's shown in the history and the audit log.");
}

function sqlError(err: unknown): never {
  const m = err instanceof Error ? err.message : String(err);
  if (m.includes("self_approval")) throw new HttpError(403, "A grant needs approval from someone other than the person who created it.");
  if (m.includes("grant_expired")) throw new HttpError(409, "This grant's expiry date has passed — create a new one.");
  if (m.includes("grant_not_pending")) throw new HttpError(409, "This grant isn't waiting for approval any more.");
  if (m.includes("grant_not_revocable")) throw new HttpError(409, "This grant is already expired, revoked or rejected.");
  if (m.includes("not found")) throw new HttpError(404, "Grant not found.");
  throw err instanceof Error ? err : new Error(m);
}

type GrantResult = QuotaSnapshot & { grantId: string; grantStatus: "active" | "pending"; duplicate: boolean };

function grantResult(row: Record<string, unknown>): GrantResult {
  return { ...snapshotFromRow(row), grantId: String(row.grant_id), grantStatus: row.status === "pending" ? "pending" : "active", duplicate: Boolean(row.duplicate) };
}

/** Grant kinds that are part of a promotion (email respects the marketing opt-out); the rest are account notices. */
const MARKETING_KINDS = new Set(["promotional", "campaign"]);

/**
 * Tells the person about an ACTIVE grant — never before the ledger committed it: a one-time popup,
 * the inbox, push, and an email (promotional grants honour the marketing opt-out).
 */
export async function announceGrant(userId: string | null, grantId: string, tokens: number, expiresAt: string | null, kind: string = "goodwill", popup = true): Promise<void> {
  if (!userId) return;
  const title = `You've received ${formatTokens(tokens)} bonus tokens`;
  const body = expiresAt
    ? `They're added on top of your monthly allowance and are yours until ${new Date(expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" })}.`
    : "They're added on top of your monthly allowance and don't expire.";
  await notify(userId, {
    kind: "credit_granted",
    title,
    body,
    data: { grantId, tokens, expiresAt },
    dedupe: `credit:${grantId}`,
    popup,
    email: { category: MARKETING_KINDS.has(kind) ? "marketing" : "account", cta: { label: "See your balance", path: "/?settings=usage" } },
  }).catch((err) => logger.error("credit_notification_failed", { grantId, error: err instanceof Error ? err.message : String(err) }));
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1))}M`;
  if (n >= 1_000) return `${Number((n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1))}K`;
  return String(n);
}

export type GrantInput = {
  userId?: string | null;
  organizationId?: string | null;
  tokens: number;
  expiresAt: string | null;
  kind: GrantKind;
  reason: string;
  /** Client-generated per click: a retried or double-clicked grant is applied once. */
  key: string;
  source?: string;
};

export async function grantCredits(input: GrantInput, actorId: string): Promise<GrantResult> {
  if (!input.userId && !input.organizationId) throw new HttpError(400, "Pick a person or an organization.");
  const settings = await getCreditSettings();
  validateGrant(input, settings);
  const approval = needsApproval(input.tokens, settings);
  let row: Record<string, unknown>;
  try {
    row = await quotaRpc<Record<string, unknown>>("quota_grant_credits", {
      p_user: input.organizationId ? null : input.userId,
      p_org: input.organizationId ?? null,
      p_tokens: input.tokens,
      p_expires_at: input.expiresAt,
      p_kind: input.kind,
      p_reason: input.reason.trim(),
      p_actor: actorId,
      p_key: `grant:${input.key}`,
      p_requires_approval: approval,
      p_source: input.source ?? "console",
    });
  } catch (err) {
    sqlError(err);
  }
  const result = grantResult(row);
  if (result.grantStatus === "active" && !result.duplicate) await announceGrant(input.organizationId ? null : (input.userId ?? null), result.grantId, input.tokens, input.expiresAt, input.kind);
  return result;
}

export async function approveGrant(grantId: string, approverId: string): Promise<GrantResult> {
  let row: Record<string, unknown>;
  try {
    row = await quotaRpc<Record<string, unknown>>("quota_approve_credit_grant", { p_grant: grantId, p_approver: approverId });
  } catch (err) {
    sqlError(err);
  }
  const result = grantResult(row);
  if (!result.duplicate) {
    const { data } = await supabaseAdmin.from("quota_credit_grants").select("user_id, tokens, expires_at, kind").eq("id", grantId).maybeSingle();
    if (data) await announceGrant(data.user_id as string | null, grantId, Number(data.tokens), (data.expires_at as string | null) ?? null, data.kind as string);
  }
  return result;
}

export async function revokeGrant(grantId: string, actorId: string, reason: string): Promise<{ status: string; takenBack: number }> {
  if (reason.trim().length < 3) throw new HttpError(400, "Say why the grant is revoked.");
  try {
    const row = await quotaRpc<Record<string, unknown>>("quota_revoke_credit_grant", { p_grant: grantId, p_actor: actorId, p_reason: reason.trim() });
    return { status: String(row.status), takenBack: Number(row.taken_back ?? 0) };
  } catch (err) {
    sqlError(err);
  }
}

// ── Bulk ────────────────────────────────────────────────────────────────────────────────────────

export type Audience =
  | { kind: "all" }
  | { kind: "plans"; plans: string[] }
  | { kind: "emails"; emails: string[] }
  | { kind: "signed_up"; from: string; to: string };

type AudienceRow = { id: string; email: string | null; full_name: string | null; plan: string };

/** Walks the whole audience (paged); stops one past `cap` so callers can tell "too many". */
export async function resolveAudience(audience: Audience, cap: number): Promise<AudienceRow[]> {
  const out: AudienceRow[] = [];
  let after: string | null = null;
  const args = {
    p_kind: audience.kind,
    p_plans: audience.kind === "plans" ? audience.plans : [],
    p_emails: audience.kind === "emails" ? [...new Set(audience.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))] : [],
    p_from: audience.kind === "signed_up" ? audience.from : null,
    p_to: audience.kind === "signed_up" ? audience.to : null,
  };
  for (;;) {
    const { data, error } = await supabaseAdmin.rpc("credit_grant_audience", { ...args, p_after: after, p_limit: 1000 });
    if (error) throw new Error(error.message);
    const page = (data ?? []) as AudienceRow[];
    out.push(...page);
    if (page.length < 1000 || out.length > cap) break;
    after = page[page.length - 1]!.id;
  }
  return out.slice(0, cap + 1);
}

export async function previewBulk(audience: Audience, tokens: number) {
  const settings = await getCreditSettings();
  const people = await resolveAudience(audience, settings.bulkMaxRecipients);
  const count = Math.min(people.length, settings.bulkMaxRecipients);
  const missingEmails =
    audience.kind === "emails"
      ? audience.emails.map((e) => e.trim().toLowerCase()).filter((e) => e && !people.some((p) => p.email?.toLowerCase() === e))
      : [];
  return {
    count,
    tooMany: people.length > settings.bulkMaxRecipients,
    maxRecipients: settings.bulkMaxRecipients,
    totalTokens: count * tokens,
    requiresApproval: needsApproval(count * tokens, settings),
    sample: people.slice(0, 8).map((p) => ({ id: p.id, name: p.full_name || p.email?.split("@")[0] || "User", email: p.email, plan: p.plan })),
    missingEmails: missingEmails.slice(0, 50),
  };
}

export type BulkInput = Omit<GrantInput, "userId" | "organizationId" | "key"> & {
  audience: Audience;
  /** Client-generated per click; also the batch id, so a retried submit can't start a second batch. */
  batchId: string;
  /** The count the admin saw in the preview — refused if the audience changed since. */
  expectedCount: number;
};

export async function grantBulk(input: BulkInput, actorId: string) {
  const settings = await getCreditSettings();
  validateGrant(input, settings);
  const people = await resolveAudience(input.audience, settings.bulkMaxRecipients);
  if (people.length > settings.bulkMaxRecipients) throw new HttpError(400, `That's more than ${settings.bulkMaxRecipients.toLocaleString("en-IN")} people — narrow the audience.`);
  if (people.length === 0) throw new HttpError(400, "Nobody matches this audience.");
  if (people.length !== input.expectedCount) throw new HttpError(409, `The audience changed since the preview (${input.expectedCount} → ${people.length}). Preview again before granting.`);
  const approval = needsApproval(people.length * input.tokens, settings);
  let created = 0;
  let duplicates = 0;
  const failed: string[] = [];
  const toAnnounce: Array<{ userId: string; grantId: string }> = [];
  // Sequential on purpose: each grant locks one account row; a burst of thousands of parallel
  // transactions would only contend with live traffic. Retries are safe (keys are batch:user).
  for (const person of people) {
    try {
      const row = await quotaRpc<Record<string, unknown>>("quota_grant_credits", {
        p_user: person.id,
        p_org: null,
        p_tokens: input.tokens,
        p_expires_at: input.expiresAt,
        p_kind: input.kind,
        p_reason: input.reason.trim(),
        p_actor: actorId,
        p_key: `bulk:${input.batchId}:${person.id}`,
        p_requires_approval: approval,
        p_batch: input.batchId,
        p_source: input.source ?? "bulk",
      });
      const r = grantResult(row);
      if (r.duplicate) duplicates++;
      else created++;
      if (r.grantStatus === "active" && !r.duplicate) toAnnounce.push({ userId: person.id, grantId: r.grantId });
    } catch (err) {
      failed.push(person.id);
      logger.error("bulk_credit_grant_failed", { batchId: input.batchId, userId: person.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  void announceAll(toAnnounce, input.tokens, input.expiresAt, input.kind);
  return { batchId: input.batchId, created, duplicates, failed: failed.length, status: approval ? "pending" : "active" };
}

async function announceAll(list: Array<{ userId: string; grantId: string }>, tokens: number, expiresAt: string | null, kind: string) {
  for (const g of list) await announceGrant(g.userId, g.grantId, tokens, expiresAt, kind).catch(() => undefined);
}

/** Approves every pending grant of a batch (one approver for the whole batch, not its creator). */
export async function approveBatch(batchId: string, approverId: string) {
  const { data, error } = await supabaseAdmin.from("quota_credit_grants").select("id").eq("batch_id", batchId).eq("status", "pending");
  if (error) throw new Error(error.message);
  let approved = 0;
  for (const g of data ?? []) {
    await approveGrant(g.id as string, approverId);
    approved++;
  }
  return { approved };
}

export async function rejectBatch(batchId: string, actorId: string, reason: string) {
  const { data, error } = await supabaseAdmin.from("quota_credit_grants").select("id").eq("batch_id", batchId).eq("status", "pending");
  if (error) throw new Error(error.message);
  for (const g of data ?? []) await revokeGrant(g.id as string, actorId, reason);
  return { rejected: (data ?? []).length };
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

export type GrantRow = {
  id: string;
  account_id: string;
  user_id: string | null;
  organization_id: string | null;
  tokens: number;
  remaining: number;
  status: "pending" | "active" | "expired" | "revoked" | "rejected";
  kind: GrantKind;
  source: string;
  reason: string;
  expires_at: string | null;
  batch_id: string | null;
  created_by: string | null;
  approved_by: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  expired_tokens: number;
  revoked_tokens: number;
  created_at: string;
};

export async function listGrants(filter: { status?: string; userId?: string; batchId?: string; limit?: number } = {}) {
  let q = supabaseAdmin.from("quota_credit_grants").select("*").order("created_at", { ascending: false }).limit(Math.min(500, filter.limit ?? 200));
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.userId) q = q.eq("user_id", filter.userId);
  if (filter.batchId) q = q.eq("batch_id", filter.batchId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as GrantRow[];
  const labels = await userLabels(rows.map((g) => g.user_id)).catch(() => ({}) as Awaited<ReturnType<typeof userLabels>>);
  return rows.map((g) => ({
    ...g,
    tokens: Number(g.tokens),
    remaining: Number(g.remaining),
    expired_tokens: Number(g.expired_tokens),
    revoked_tokens: Number(g.revoked_tokens),
    recipient: g.user_id ? (labels[g.user_id] ?? null) : null,
  }));
}

/** Console summary: what's outstanding, waiting, expiring soon, and used. */
export async function creditSummary(now = Date.now()) {
  const soon = new Date(now + 7 * 86_400_000).toISOString();
  const monthStart = new Date(now - 30 * 86_400_000).toISOString();
  const [active, pending, expiring, recent, draws] = await Promise.all([
    supabaseAdmin.from("quota_credit_grants").select("remaining").eq("status", "active").gt("remaining", 0),
    supabaseAdmin.from("quota_credit_grants").select("id, tokens", { count: "exact" }).eq("status", "pending"),
    supabaseAdmin.from("quota_credit_grants").select("remaining").eq("status", "active").gt("remaining", 0).not("expires_at", "is", null).lte("expires_at", soon),
    supabaseAdmin.from("quota_credit_grants").select("tokens").gte("created_at", monthStart).in("status", ["active", "expired", "revoked"]),
    supabaseAdmin.from("quota_credit_draws").select("tokens").gte("created_at", monthStart),
  ]);
  const sum = (rows: Array<Record<string, unknown>> | null, k: string) => (rows ?? []).reduce((n, r) => n + Number(r[k] ?? 0), 0);
  return {
    outstanding: sum(active.data, "remaining"),
    pendingCount: pending.count ?? 0,
    pendingTokens: sum(pending.data, "tokens"),
    expiringIn7Days: sum(expiring.data, "remaining"),
    granted30d: sum(recent.data, "tokens"),
    used30d: sum(draws.data, "tokens"),
  };
}

/** The signed-in person's own grants (Settings → Usage): what's left and when it expires. */
export async function myCredits(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("quota_credit_grants")
    .select("id, tokens, remaining, kind, expires_at, created_at, status")
    .eq("user_id", userId)
    .in("status", ["active"])
    .gt("remaining", 0)
    .order("expires_at", { ascending: true, nullsFirst: false });
  if (error) throw new Error(error.message);
  const grants = (data ?? []).map((g) => ({ id: g.id as string, tokens: Number(g.tokens), remaining: Number(g.remaining), kind: g.kind as string, expiresAt: (g.expires_at as string | null) ?? null, grantedAt: g.created_at as string }));
  return { balance: grants.reduce((n, g) => n + g.remaining, 0), grants };
}
