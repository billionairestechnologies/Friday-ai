import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { adjustQuota, quotaRpc, type AdjustmentKind } from "../quota/tokenQuotaService.js";
import { usageReport } from "../quota/usageReport.js";
import { percentUsed, remainingOf } from "../quota/allowance.js";
import { userLabels } from "./directory.js";

/**
 * Team Console → Usage ledger: every customer's balance, where it went, what's still holding
 * tokens, and anything that doesn't add up. Read straight from the ledger tables (supabase 0051);
 * every change an admin makes is an append-only adjustment, never an edit of past usage.
 */

/** A reservation silent this long is probably a crashed request (live ones heartbeat every model round). */
const STUCK_AFTER_MS = 30 * 60_000;

type AccountRow = {
  id: string;
  user_id: string | null;
  organization_id: string | null;
  plan: string;
  allowance: number;
  used: number;
  adjustments: number;
  reserved: number;
  period_start: string;
  period_end: string;
  status: "active" | "suspended";
  pending_plan: string | null;
  updated_at: string;
};

async function describe(rows: AccountRow[]) {
  const labels = await userLabels(rows.map((r) => r.user_id));
  const orgIds = rows.map((r) => r.organization_id).filter((id): id is string => Boolean(id));
  const { data: orgs } = orgIds.length ? await supabaseAdmin.from("organizations").select("id, name").in("id", orgIds) : { data: [] };
  const orgName = new Map((orgs ?? []).map((o) => [o.id as string, o.name as string]));
  const profileIds = rows.map((r) => r.user_id).filter((id): id is string => Boolean(id));
  const { data: profiles } = profileIds.length ? await supabaseAdmin.from("profiles").select("id, plan_renews_at").in("id", profileIds) : { data: [] };
  const renews = new Map((profiles ?? []).map((p) => [p.id as string, p.plan_renews_at as string | null]));
  return rows.map((r) => {
    const n = { allowance: Number(r.allowance), used: Number(r.used), adjustments: Number(r.adjustments), reserved: Number(r.reserved) };
    return {
      id: r.id,
      kind: r.organization_id ? "organization" : "individual",
      userId: r.user_id,
      organizationId: r.organization_id,
      name: r.organization_id ? (orgName.get(r.organization_id) ?? "Organization") : (labels[r.user_id ?? ""]?.name ?? "Unknown"),
      email: r.user_id ? (labels[r.user_id]?.email ?? null) : null,
      plan: r.plan,
      ...n,
      remaining: remainingOf(n),
      percent: percentUsed(n),
      periodStart: r.period_start,
      periodEnd: r.period_end,
      renewsAt: r.user_id ? (renews.get(r.user_id) ?? null) : null,
      pendingPlan: r.pending_plan,
      status: r.status,
      updatedAt: r.updated_at,
    };
  });
}

export async function usageOverview() {
  const now = Date.now();
  const [accounts, active, discrepancies, estimated, failedCalls, events] = await Promise.all([
    supabaseAdmin.from("quota_accounts").select("id, allowance, used, adjustments, reserved, status, plan"),
    supabaseAdmin.from("quota_reservations").select("id, account_id, user_id, feature, hold, consumed, created_at, heartbeat_at").eq("status", "active").order("heartbeat_at"),
    quotaRpc<Array<{ account_id: string; field: string; stored: number; computed: number }>>("quota_audit", {}).catch((err: Error) => [{ account_id: "", field: `audit failed: ${err.message}`, stored: 0, computed: 0 }]),
    supabaseAdmin.from("token_ledger").select("id", { count: "exact", head: true }).eq("usage_source", "estimated").gt("billable_tokens", 0).gte("created_at", new Date(now - 86_400_000).toISOString()),
    supabaseAdmin.from("token_ledger").select("id", { count: "exact", head: true }).in("call_status", ["failed", "partial"]).gte("created_at", new Date(now - 86_400_000).toISOString()),
    supabaseAdmin.from("subscription_events").select("id, user_id, organization_id, kind, plan, order_id, details, created_at").order("created_at", { ascending: false }).limit(40),
  ]);
  const rows = (accounts.data ?? []) as Array<{ allowance: number; used: number; adjustments: number; reserved: number; status: string; plan: string }>;
  const exhausted = rows.filter((r) => remainingOf({ allowance: Number(r.allowance), used: Number(r.used), adjustments: Number(r.adjustments), reserved: Number(r.reserved) }) <= 0).length;
  const near = rows.filter((r) => percentUsed({ allowance: Number(r.allowance), used: Number(r.used), adjustments: Number(r.adjustments) }) >= 80).length;
  const reservations = (active.data ?? []) as Array<{ id: string; account_id: string; user_id: string; feature: string; hold: number; consumed: number; created_at: string; heartbeat_at: string }>;
  const stuck = reservations.filter((r) => now - new Date(r.heartbeat_at).getTime() > STUCK_AFTER_MS);
  const eventRows = (events.data ?? []) as Array<{ user_id: string | null; [k: string]: unknown }>;
  const labels = await userLabels([...eventRows.map((e) => e.user_id), ...stuck.map((r) => r.user_id)]);
  return {
    accounts: rows.length,
    suspended: rows.filter((r) => r.status === "suspended").length,
    exhausted,
    near,
    usedThisPeriod: rows.reduce((n, r) => n + Number(r.used), 0),
    reservedNow: reservations.reduce((n, r) => n + Number(r.hold), 0),
    activeReservations: reservations.length,
    stuckReservations: stuck.map((r) => ({ ...r, name: labels[r.user_id]?.name ?? "Unknown" })),
    discrepancies,
    estimatedChargeableLast24h: estimated.count ?? 0,
    failedCallsLast24h: failedCalls.count ?? 0,
    events: eventRows.map((e) => ({ ...e, name: e.user_id ? (labels[e.user_id]?.name ?? "Unknown") : null })),
  };
}

export async function listUsageAccounts(opts: { q?: string; filter?: "all" | "exhausted" | "near" | "suspended"; limit?: number }) {
  let ids: string[] | null = null;
  if (opts.q?.trim()) {
    const term = opts.q.trim();
    const [{ data: people }, { data: orgs }] = await Promise.all([
      supabaseAdmin.from("profiles").select("id").ilike("full_name", `%${term}%`).limit(50),
      supabaseAdmin.from("organizations").select("id").ilike("name", `%${term}%`).limit(50),
    ]);
    const [{ data: byUser }, { data: byOrg }] = await Promise.all([
      supabaseAdmin.from("quota_accounts").select("id").in("user_id", [...(people ?? []).map((p) => p.id as string), /^[0-9a-f-]{36}$/i.test(term) ? term : "00000000-0000-0000-0000-000000000000"]),
      supabaseAdmin.from("quota_accounts").select("id").in("organization_id", (orgs ?? []).map((o) => o.id as string).concat("00000000-0000-0000-0000-000000000000")),
    ]);
    ids = [...(byUser ?? []), ...(byOrg ?? [])].map((r) => r.id as string);
    if (/^[0-9a-f-]{36}$/i.test(term)) ids.push(term);
  }
  let query = supabaseAdmin.from("quota_accounts").select("*").order("updated_at", { ascending: false }).limit(Math.min(500, opts.limit ?? 200));
  if (ids) query = query.in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  if (opts.filter === "suspended") query = query.eq("status", "suspended");
  const { data, error } = await query;
  if (error) throw new HttpError(500, error.message);
  let rows = await describe((data ?? []) as AccountRow[]);
  if (opts.filter === "exhausted") rows = rows.filter((r) => r.remaining <= 0);
  if (opts.filter === "near") rows = rows.filter((r) => r.percent >= 80);
  return rows;
}

export async function usageAccountDetail(accountId: string) {
  const { data, error } = await supabaseAdmin.from("quota_accounts").select("*").eq("id", accountId).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "No such usage account");
  const [account] = await describe([data as AccountRow]);
  const [report, reservations, adjustments, events] = await Promise.all([
    usageReport(accountId, (data as AccountRow).period_start, null, { includeAdjustments: true }),
    supabaseAdmin.from("quota_reservations").select("id, user_id, feature, hold, consumed, status, created_at, heartbeat_at, settled_at").eq("account_id", accountId).order("created_at", { ascending: false }).limit(30),
    supabaseAdmin.from("quota_adjustments").select("id, period_start, tokens, kind, reason, actor_id, created_at").eq("account_id", accountId).order("created_at", { ascending: false }).limit(100),
    account!.userId
      ? supabaseAdmin.from("subscription_events").select("id, kind, plan, order_id, details, created_at").eq("user_id", account!.userId).order("created_at", { ascending: false }).limit(50)
      : supabaseAdmin.from("subscription_events").select("id, kind, plan, order_id, details, created_at").eq("organization_id", account!.organizationId!).order("created_at", { ascending: false }).limit(50),
  ]);
  const actors = await userLabels((adjustments.data ?? []).map((a) => a.actor_id as string | null));
  return {
    account,
    report,
    reservations: reservations.data ?? [],
    adjustments: (adjustments.data ?? []).map((a) => ({ ...a, actor: a.actor_id ? (actors[a.actor_id as string]?.name ?? "Staff") : "System" })),
    events: events.data ?? [],
  };
}

export async function adjustUsageAccount(accountId: string, input: { tokens: number; kind: AdjustmentKind; reason: string; key?: string }, actorId: string) {
  return adjustQuota({ accountId, tokens: input.tokens, kind: input.kind, reason: input.reason, actorId, key: input.key ?? `console:${randomUUID()}` });
}

/** Suspending blocks every new billable request at once (quota_reserve refuses); history is untouched. */
export async function setUsageAccountSuspended(accountId: string, suspended: boolean, reason: string, actorId: string) {
  const { data, error } = await supabaseAdmin
    .from("quota_accounts")
    .update({ status: suspended ? "suspended" : "active", updated_at: new Date().toISOString() })
    .eq("id", accountId)
    .select("user_id, organization_id")
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "No such usage account");
  await supabaseAdmin.from("subscription_events").insert({
    user_id: data.user_id,
    organization_id: data.organization_id,
    kind: suspended ? "suspended" : "unsuspended",
    idempotency_key: `console:${randomUUID()}`,
    details: { reason, actorId },
  });
}

/** Recent calls that need a look: failed / partial / aborted, or with estimated usage. */
export async function listFlaggedCalls(opts: { kind: "failed" | "estimated"; limit?: number }) {
  let q = supabaseAdmin
    .from("token_ledger")
    .select("id, created_at, user_id, account_id, provider_slug, model_id, feature, input_tokens, output_tokens, cached_tokens, billable_tokens, usage_source, call_status, overrun_tokens, latency_ms, cost_usd")
    .order("created_at", { ascending: false })
    .limit(Math.min(500, opts.limit ?? 200));
  q = opts.kind === "failed" ? q.in("call_status", ["failed", "partial", "aborted"]) : q.eq("usage_source", "estimated");
  const { data, error } = await q;
  if (error) throw new HttpError(500, error.message);
  const labels = await userLabels((data ?? []).map((r) => r.user_id as string));
  return (data ?? []).map((r) => ({ ...r, name: labels[r.user_id as string]?.name ?? "Unknown" }));
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The raw ledger between two dates as CSV (max 50,000 rows) — for audits and reconciliation outside the console. */
export async function exportLedgerCsv(from: string, to: string): Promise<string> {
  const columns = [
    "created_at", "id", "account_id", "user_id", "organization_id", "reservation_id", "idempotency_key", "period_start", "feature",
    "provider_slug", "model_id", "input_tokens", "output_tokens", "total_tokens", "cached_tokens", "cache_write_tokens", "reasoning_tokens",
    "billable_tokens", "overrun_tokens", "usage_source", "call_status", "streaming", "latency_ms", "cost_usd", "meter_version",
  ];
  const lines = [columns.join(",")];
  for (let offset = 0; offset < 50_000; offset += 1000) {
    const { data, error } = await supabaseAdmin
      .from("token_ledger")
      .select(columns.join(", "))
      .gte("created_at", from)
      .lt("created_at", to)
      .not("account_id", "is", null)
      .order("created_at")
      .range(offset, offset + 999);
    if (error) throw new HttpError(500, error.message);
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) lines.push(columns.map((c) => csvCell(row[c])).join(","));
    if (!data || data.length < 1000) break;
  }
  return lines.join("\n");
}
