import { randomUUID } from "node:crypto";
import { memoAsync } from "../../utils/ttlMemo.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../utils/logger.js";
import {
  ENTERPRISE_MIN_SEATS,
  ENTERPRISE_TOKENS_PER_SEAT,
  PLAN_ALLOWANCES,
  planSatisfiesTier,
  type Plan,
} from "./tierConfig.js";
import { getPlanCatalog } from "./planCatalog.js";
import { snapshotFromRow, type QuotaBlockReason, type QuotaSnapshot } from "./allowance.js";

export type { Plan } from "./tierConfig.js";

/**
 * Server-side quota enforcement. The balance lives in Postgres (supabase 0051) and every change
 * goes through a row-locked SQL function, so two requests — on one server or ten — can never spend
 * the same tokens. Nothing here is cached or kept in Redis: the database IS the balance, and if it
 * can't be reached a billable request is refused ("unavailable"), never let through unmetered.
 *
 * Request lifecycle (UsageMeter in usageMeter.ts wraps the last three for a whole turn):
 *   checkAndReserve  → hold an estimate before any model is called (refused = HTTP 429/403/503)
 *   extendHold       → grow the hold when the real prompt / next agent round is known
 *   recordUsage      → one ledger row per model invocation, idempotent, releases hold as it goes
 *   settleReservation→ give back whatever hold is left (idempotent)
 */

// ── RPC transport (injectable so tests run the real SQL on a throwaway Postgres) ──────────────────

export type QuotaRpc = <T = unknown>(fn: string, args: Record<string, unknown>) => Promise<T>;

export class QuotaUnavailableError extends Error {}

const supabaseRpc: QuotaRpc = async <T>(fn: string, args: Record<string, unknown>) => {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) throw new QuotaUnavailableError(`${fn}: ${error.message}`);
  return data as T;
};

let rpc: QuotaRpc = supabaseRpc;

/** Test hook: route the quota SQL functions somewhere else (pass null to restore Supabase). */
export function setQuotaRpcForTests(next: QuotaRpc | null) {
  rpc = next ?? supabaseRpc;
}

export function quotaRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  return rpc<T>(fn, args);
}

// ── Plan resolution ──────────────────────────────────────────────────────────────────────────────

export type EffectivePlan = {
  plan: Plan;
  planRenewsAt: string | null;
  customMonthlyCap: number | null;
  enterprise: {
    organizationId: string;
    seatCount: number;
    pooledMonthlyTokens: number;
  } | null;
};

/** A user's individual `plan` column, plus whether they're covered by an enterprise org's pool
 *  (which takes priority — pooled compute is what they're actually billed against). */
async function resolveEffectivePlanUncached(userId: string): Promise<EffectivePlan> {
  const [{ data: profile, error }, { data: membership }] = await Promise.all([
    supabaseAdmin.from("profiles").select("plan, plan_renews_at, custom_monthly_cap").eq("id", userId).maybeSingle(),
    supabaseAdmin
      .from("organization_memberships")
      .select("organization_id, organizations(plan, seat_count, pooled_monthly_tokens)")
      .eq("user_id", userId),
  ]);
  if (error) logger.warn("quota_profile_lookup_failed", { userId, error: error.message });

  const enterpriseRow = (membership ?? []).find((row) => {
    const org = row.organizations as { plan: string } | { plan: string }[] | null;
    const resolved = Array.isArray(org) ? org[0] : org;
    return resolved?.plan === "enterprise";
  });

  let enterprise: EffectivePlan["enterprise"] = null;
  if (enterpriseRow) {
    const org = enterpriseRow.organizations as
      | { plan: string; seat_count: number; pooled_monthly_tokens: number | null }
      | { plan: string; seat_count: number; pooled_monthly_tokens: number | null }[]
      | null;
    const resolved = Array.isArray(org) ? org[0] : org;
    if (resolved) {
      const seatCount = Math.max(ENTERPRISE_MIN_SEATS, resolved.seat_count ?? ENTERPRISE_MIN_SEATS);
      const perSeat = (await allowanceTable().catch(() => null))?.enterprise_per_seat ?? ENTERPRISE_TOKENS_PER_SEAT;
      enterprise = {
        organizationId: enterpriseRow.organization_id as string,
        seatCount,
        pooledMonthlyTokens: resolved.pooled_monthly_tokens ?? seatCount * perSeat,
      };
    }
  }

  return {
    plan: (profile?.plan as Plan) ?? "free",
    planRenewsAt: profile?.plan_renews_at ?? null,
    customMonthlyCap: profile?.custom_monthly_cap ?? null,
    enterprise,
  };
}

/** Memoized briefly (single-flight) — used for routing/entitlements, never as the balance. */
export const resolveEffectivePlan = memoAsync(15_000, resolveEffectivePlanUncached, (userId) => userId);

/** The uncached lookup the balance paths use; replaceable in tests (they run the SQL without Supabase). */
let planLookup: (userId: string) => Promise<EffectivePlan> = resolveEffectivePlanUncached;
export function setPlanLookupForTests(fn: ((userId: string) => Promise<EffectivePlan>) | null) {
  planLookup = fn ?? resolveEffectivePlanUncached;
}

/** Per-plan allowances as the SQL functions want them: the console catalog over the code defaults. */
export async function allowanceTable(): Promise<Record<string, number>> {
  const catalog = await getPlanCatalog().catch(() => null);
  const of = (id: string) => catalog?.find((p) => p.id === id);
  return {
    free: of("free")?.limits.monthly ?? PLAN_ALLOWANCES.free,
    pro: of("pro")?.limits.monthly ?? PLAN_ALLOWANCES.pro,
    premium: of("premium")?.limits.monthly ?? PLAN_ALLOWANCES.premium,
    enterprise_per_seat: of("enterprise")?.limits.tokensPerSeat ?? ENTERPRISE_TOKENS_PER_SEAT,
    enterprise_min_seats: of("enterprise")?.minSeats ?? ENTERPRISE_MIN_SEATS,
  };
}

/** Pre-flight hold, in billable tokens: the message (~4 chars/token) plus a completion buffer.
 *  The real prompt replaces it via extendHold as soon as the turn has built it. */
export function estimateReservationTokens(promptChars: number, completionBufferTokens = 800): number {
  return Math.max(1, Math.ceil(Math.max(0, promptChars) / 4) + Math.max(0, completionBufferTokens));
}

// ── Reservation lifecycle ────────────────────────────────────────────────────────────────────────

export type LedgerFeature = "chat" | "build" | "research" | "teamup" | "spark" | "automation" | "code";

export type Reservation = {
  id: string;
  userId: string;
  organizationId: string | null;
  accountId: string;
  feature: LedgerFeature;
  conversationId: string | null;
  /** The hold as last confirmed by the database. */
  hold: number;
  /** The period's allowance when the hold was taken (sizes the per-turn runaway guard). */
  allowance: number;
  periodEnd: string;
  settled: boolean;
};

export type QuotaCheckResult =
  | { allowed: true; reservation: Reservation; snapshot: QuotaSnapshot }
  | { allowed: false; reason: QuotaBlockReason; resetAt: Date | null; snapshot: QuotaSnapshot | null };

type SqlResult = Record<string, unknown> & { ok?: boolean; reason?: string };

function blockReason(raw: unknown): QuotaBlockReason {
  return raw === "member_cap" || raw === "suspended" || raw === "exhausted" ? raw : "exhausted";
}

const isUuid = (v: string | null | undefined) => Boolean(v && /^[0-9a-f-]{36}$/i.test(v));

/**
 * Holds `amount` billable tokens before a request is sent upstream. Refused when the balance
 * can't cover it, the account is suspended, or the ledger is unreachable (fail CLOSED — a database
 * outage must not become unlimited free usage).
 */
export async function checkAndReserve(
  userId: string,
  amount: number,
  opts: { feature?: LedgerFeature; conversationId?: string | null; reservationId?: string } = {},
): Promise<QuotaCheckResult> {
  const id = opts.reservationId ?? randomUUID();
  try {
    const effective = await planLookup(userId);
    const orgId = effective.enterprise?.organizationId ?? null;
    const row = await rpc<SqlResult>("quota_reserve", {
      p_reservation: id,
      p_user: userId,
      p_org: orgId,
      p_amount: Math.max(0, Math.ceil(amount)),
      p_allowances: await allowanceTable(),
      p_feature: opts.feature ?? "chat",
      p_conversation: isUuid(opts.conversationId) ? opts.conversationId : null,
    });
    const snapshot = snapshotFromRow(row);
    if (!row.ok) {
      const reason = blockReason(row.reason);
      return { allowed: false, reason, resetAt: reason === "suspended" ? null : new Date(snapshot.periodEnd), snapshot };
    }
    return {
      allowed: true,
      snapshot,
      reservation: {
        id,
        userId,
        organizationId: orgId,
        accountId: snapshot.accountId,
        feature: opts.feature ?? "chat",
        conversationId: opts.conversationId ?? null,
        hold: Math.max(0, Math.ceil(amount)),
        allowance: snapshot.allowance,
        periodEnd: snapshot.periodEnd,
        settled: false,
      },
    };
  } catch (err) {
    logger.error("quota_reserve_failed", { userId, error: err instanceof Error ? err.message : String(err) });
    return { allowed: false, reason: "unavailable", resetAt: null, snapshot: null };
  }
}

export type HoldResult = { ok: true; snapshot: QuotaSnapshot | null } | { ok: false; reason: QuotaBlockReason; snapshot: QuotaSnapshot | null };

/** Grows a running request's hold to `hold` tokens; refused (nothing changes) if the balance can't cover it. */
export async function extendHold(reservation: Reservation, hold: number): Promise<HoldResult> {
  const target = Math.max(0, Math.ceil(hold));
  if (target <= reservation.hold) return { ok: true, snapshot: null };
  try {
    const row = await rpc<SqlResult>("quota_extend_hold", { p_reservation: reservation.id, p_hold: target });
    const snapshot = snapshotFromRow(row);
    if (!row.ok) return { ok: false, reason: row.reason === "settled" ? "exhausted" : blockReason(row.reason), snapshot };
    reservation.hold = target;
    return { ok: true, snapshot };
  } catch (err) {
    logger.error("quota_extend_failed", { reservationId: reservation.id, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "unavailable", snapshot: null };
  }
}

/** One ledger row, as quota_record_usage expects it (see supabase 0051 for the column list). */
export type UsageEvent = {
  idempotency_key: string;
  organization_id: string | null;
  provider_slug: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  billable_tokens: number;
  usage_source: "provider" | "estimated" | "none";
  call_status: "ok" | "partial" | "failed" | "aborted";
  feature: LedgerFeature;
  conversation_id: string | null;
  request_id: string | null;
  attempt: number | null;
  streaming: boolean | null;
  latency_ms: number | null;
  cost_usd: number | null;
  sell_inr: number | null;
  priced: boolean;
  estimated_cost_cents: number;
  meter_version: string;
};

export type RecordResult = {
  /** false = the balance is used up (or the ledger is down): start no further model calls. */
  ok: boolean;
  reason?: QuotaBlockReason;
  duplicate?: boolean;
  /** Highest usage notice threshold (80/95/100) this record newly crossed, else 0. */
  crossed: number;
  snapshot: QuotaSnapshot | null;
};

/** Writes one usage event exactly once (idempotency_key); throws QuotaUnavailableError if the ledger is unreachable. */
export async function recordUsage(reservation: Reservation, event: UsageEvent): Promise<RecordResult> {
  const row = await rpc<SqlResult>("quota_record_usage", { p_reservation: reservation.id, p_event: event });
  const snapshot = snapshotFromRow(row);
  reservation.hold = Math.max(0, reservation.hold - (row.duplicate ? 0 : Math.min(reservation.hold, event.billable_tokens)));
  const crossed = Number(row.crossed ?? 0) || 0;
  return { ok: Boolean(row.ok), ...(row.ok ? {} : { reason: "exhausted" as const }), duplicate: Boolean(row.duplicate), crossed, snapshot };
}

/** Releases what's left of the hold. Idempotent; retried, then left to the stale-reservation sweep. */
export async function settleReservation(reservation: Reservation | undefined, status: "settled" | "failed" = "settled"): Promise<void> {
  if (!reservation || reservation.settled) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await rpc("quota_settle", { p_reservation: reservation.id, p_status: status });
      reservation.settled = true;
      reservation.hold = 0;
      return;
    } catch (err) {
      if (attempt === 3) {
        // The hold stays counted until quota_expire_stale_reservations releases it (2 h idle) — the
        // customer is briefly under-served, never over-served.
        logger.error("quota_settle_failed", { reservationId: reservation.id, error: err instanceof Error ? err.message : String(err) });
      } else {
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  }
}

// ── Status (dashboards) ──────────────────────────────────────────────────────────────────────────

export type SubscriptionState = "free" | "active" | "expired" | "suspended";

export type QuotaStatus = {
  plan: Plan;
  isEnterprise: boolean;
  period: {
    accountId: string;
    start: string;
    end: string;
    allowance: number;
    used: number;
    adjustments: number;
    reserved: number;
    remaining: number;
    status: "active" | "suspended";
    subscription: SubscriptionState;
    renewsAt: string | null;
    pendingPlan: string | null;
  };
  /** Back-compat for the mobile apps (they read monthly/org/memberCap buckets). */
  monthly: { used: number; limit: number; resetAt: string } | null;
  rolling: null;
  weekly: null;
  org: { used: number; limit: number; seatCount: number; resetAt: string } | null;
  memberCap: { used: number; limit: number } | null;
};

/**
 * What a usage meter shows for a counter: never below 0 and never above the limit (bonuses make
 * used + adjustments negative; an in-flight call can overrun the last few tokens).
 */
export function meterValue(used: number, limit: number): number {
  return Math.max(0, Math.min(Number.isFinite(used) ? used : 0, limit));
}

export async function getQuotaStatus(userId: string): Promise<QuotaStatus> {
  const effective = await planLookup(userId);
  const orgId = effective.enterprise?.organizationId ?? null;
  const row = await rpc<SqlResult>("quota_sync", { p_user: userId, p_org: orgId, p_allowances: await allowanceTable() });
  const s = snapshotFromRow(row);
  // Re-read the plan: quota_sync may just have expired a lapsed term.
  const after = orgId ? effective : await planLookup(userId);
  const consumed = s.used + s.adjustments;
  const subscription: SubscriptionState =
    s.status === "suspended"
      ? "suspended"
      : orgId || after.plan !== "free"
        ? "active"
        : effective.plan !== "free"
          ? "expired"
          : "free";
  const memberCap = row.member_cap == null ? null : Number(row.member_cap);
  return {
    plan: after.plan,
    isEnterprise: Boolean(orgId),
    period: {
      accountId: s.accountId,
      start: s.periodStart,
      end: s.periodEnd,
      allowance: s.allowance,
      used: s.used,
      adjustments: s.adjustments,
      reserved: s.reserved,
      remaining: Math.max(0, s.remaining),
      status: s.status,
      subscription,
      renewsAt: orgId ? null : after.planRenewsAt,
      pendingPlan: (row.pending_plan as string | null) ?? null,
    },
    monthly: orgId ? null : { used: meterValue(consumed, s.allowance), limit: s.allowance, resetAt: s.periodEnd },
    rolling: null,
    weekly: null,
    org: orgId ? { used: meterValue(consumed, s.allowance), limit: s.allowance, seatCount: effective.enterprise!.seatCount, resetAt: s.periodEnd } : null,
    memberCap: orgId && memberCap != null ? { used: meterValue(Number(row.member_used ?? 0), memberCap), limit: memberCap } : null,
  };
}

// ── Admin adjustments (append-only; Team Console + admin API) ────────────────────────────────────

async function accountIdFor(userId: string): Promise<string> {
  const effective = await planLookup(userId);
  const row = await rpc<SqlResult>("quota_sync", {
    p_user: userId,
    p_org: effective.enterprise?.organizationId ?? null,
    p_allowances: await allowanceTable(),
  });
  return snapshotFromRow(row).accountId;
}

export type AdjustmentKind = "bonus" | "reset" | "refund" | "correction" | "debit";

/** Positive tokens consume allowance, negative give it back. `key` makes a retried click a no-op. */
export async function adjustQuota(input: {
  accountId?: string;
  userId?: string;
  tokens: number;
  kind: AdjustmentKind;
  reason: string;
  actorId: string | null;
  key?: string;
}): Promise<QuotaSnapshot> {
  const accountId = input.accountId ?? (input.userId ? await accountIdFor(input.userId) : null);
  if (!accountId) throw new Error("No quota account to adjust");
  const row = await rpc<SqlResult>("quota_adjust", {
    p_account: accountId,
    p_tokens: Math.trunc(input.tokens),
    p_kind: input.kind,
    p_reason: input.reason,
    p_actor: input.actorId,
    p_key: input.key ?? `admin:${randomUUID()}`,
  });
  return snapshotFromRow(row);
}

/** Admin "bonus": gives `tokens` extra headroom in the CURRENT period only. */
export async function grantBonusTokens(userId: string, tokens: number, actorId: string | null = null): Promise<void> {
  await adjustQuota({ userId, tokens: -Math.abs(tokens), kind: "bonus", reason: "Bonus tokens", actorId });
}

/** Admin "reset now": gives back everything used this period (recorded as one adjustment — the usage history stays). */
export async function resetUserQuotaNow(userId: string, actorId: string | null = null): Promise<void> {
  const accountId = await accountIdFor(userId);
  const { data } = await supabaseAdmin.from("quota_accounts").select("used, adjustments").eq("id", accountId).maybeSingle();
  const consumed = Number(data?.used ?? 0) + Number(data?.adjustments ?? 0);
  if (consumed > 0) await adjustQuota({ accountId, tokens: -consumed, kind: "reset", reason: "Usage reset by admin", actorId });
}

/** Whether `plan` (individual) or enterprise membership can use a model gated at `minTier`. */
export async function canUseModelTier(userId: string, minTier: Plan): Promise<boolean> {
  if (minTier === "free") return true;
  const effective = await resolveEffectivePlan(userId);
  if (effective.enterprise) return true; // spec: enterprise gets "global access to all models"
  return planSatisfiesTier(effective.plan, minTier);
}
