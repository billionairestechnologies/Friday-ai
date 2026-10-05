import { randomUUID } from "node:crypto";
import { memoAsync } from "../../utils/ttlMemo.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { getRedisClient } from "../redisClient.js";
import { logger } from "../../utils/logger.js";
import type { TokenUsage } from "../tokenUsage.js";
import { priceUsage } from "../finance/pricing.js";
import { creditsForInputTokens, DEFAULT_RESERVE_RATES } from "./meter.js";
import {
  decideQuota,
  ENTERPRISE_MIN_SEATS,
  ENTERPRISE_TOKENS_PER_SEAT,
  nextMonthlyReset,
  nextWeeklyReset,
  PLAN_LIMITS,
  planSatisfiesTier,
  ROLLING_WINDOW_SECONDS,
  WEEKLY_TTL_SECONDS,
  type Plan,
  type QuotaDecision,
} from "./tierConfig.js";
import { getCatalogPlan, planLimitsFor } from "./planCatalog.js";

export type { Plan } from "./tierConfig.js";

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
  // Two independent lookups — run them together (they used to run back to back).
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
      const perSeat = resolved.pooled_monthly_tokens == null
        ? ((await getCatalogPlan("enterprise").catch(() => null))?.limits.tokensPerSeat ?? ENTERPRISE_TOKENS_PER_SEAT)
        : 0;
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

/** Resolved once per message by the quota middleware and again by the chat service — memoized briefly
 *  (single-flight) so the second call is free. Plan changes take effect within the TTL. */
export const resolveEffectivePlan = memoAsync(15_000, resolveEffectivePlanUncached, (userId) => userId);

/** Pre-flight hold, in credits: the prompt (~4 chars/token) as fresh input plus a fixed completion buffer,
 *  both at the default rates. The real, model-priced figure replaces it as the turn is metered
 *  (chargeProgress) and reconciled. Counters were raw tokens before the credit meter; the `quota:v2:`
 *  key prefix keeps those stale numbers from being read as credits. */
export function estimateReservationTokens(promptChars: number, completionBufferTokens = 800): number {
  const input = creditsForInputTokens(Math.max(1, Math.ceil(promptChars / 4)), DEFAULT_RESERVE_RATES);
  const output = Math.ceil((completionBufferTokens * DEFAULT_RESERVE_RATES.output * 100_000) / 1_000_000);
  return Math.max(1, input + output);
}

function monthKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function rollingWindowUsed(redis: NonNullable<Awaited<ReturnType<typeof getRedisClient>>>, key: string, now: number) {
  await redis.zRemRangeByScore(key, "-inf", now - ROLLING_WINDOW_SECONDS * 1000);
  const members = await redis.zRangeByScore(key, "-inf", "+inf");
  let sum = 0;
  for (const member of members) {
    const tokens = Number(member.slice(member.lastIndexOf(":") + 1));
    if (Number.isFinite(tokens)) sum += tokens;
  }
  return sum;
}

/** When the oldest usage in the 5-hour window rolls off (the next moment the meter frees up); a full window from now if empty. */
async function rollingResetAt(redis: NonNullable<Awaited<ReturnType<typeof getRedisClient>>>, key: string, now: number): Promise<Date> {
  const oldest = await redis.zRangeWithScores(key, 0, 0).catch(() => []);
  const score = oldest[0]?.score;
  return new Date((typeof score === "number" && score > 0 ? score : now) + ROLLING_WINDOW_SECONDS * 1000);
}

async function counterGet(redis: NonNullable<Awaited<ReturnType<typeof getRedisClient>>>, key: string): Promise<number> {
  const value = await redis.get(key);
  return value ? Number(value) || 0 : 0;
}

/** INCRBY that also stamps a TTL the first time a key is created — same idiom as the existing
 *  RedisFixedWindowRateLimiter in rateLimit.ts, adapted for variable (token-count) increments
 *  instead of a flat +1, where "count === 1" can't be used to detect a fresh key. */
async function counterIncr(
  redis: NonNullable<Awaited<ReturnType<typeof getRedisClient>>>,
  key: string,
  by: number,
  ttlSeconds: number,
): Promise<number> {
  const total = await redis.incrBy(key, by);
  const ttl = await redis.pTTL(key);
  if (ttl === -1) await redis.expire(key, ttlSeconds);
  return total;
}

/**
 * The limits that actually apply to a person. A personal monthly cap (set by a package, an access
 * grant or an admin — profiles.custom_monthly_cap) replaces the plan's monthly ceiling; when it is
 * larger than the plan's own month, the weekly and 5-hour windows scale up with it so a generous
 * custom package isn't silently throttled back to the base plan's weekly pace.
 */
export function effectiveIndividualLimits(
  plan: Plan,
  customMonthlyCap: number | null,
  // The plan's own limits — from the console-edited catalog (planLimitsFor); code defaults otherwise.
  base: { rolling: number; weekly: number; monthly: number | null } = {
    rolling: PLAN_LIMITS[plan].rollingWindowTokens,
    weekly: PLAN_LIMITS[plan].weeklyTokens,
    monthly: PLAN_LIMITS[plan].monthlyTokens,
  },
) {
  if (customMonthlyCap == null) return { ...base };
  const baseMonth = base.monthly ?? Math.round(base.weekly * 4.3);
  const scale = customMonthlyCap > baseMonth ? customMonthlyCap / baseMonth : 1;
  return {
    rolling: Math.round(base.rolling * scale),
    weekly: Math.round(base.weekly * scale),
    monthly: customMonthlyCap,
  };
}

export type Reservation = {
  userId?: string;
  reserveTokens: number;
  /** Tokens already counted against the user's windows for this turn (starts at reserveTokens and
   *  grows as chargeProgress() meters a long turn). reconcileQuota corrects from this. */
  charged?: number;
  /** Extra rolling-window members added by chargeProgress (removed again on reconcile). */
  progressMembers?: string[];
  /** The limits this turn is metered against. */
  limits?: { rolling?: number; weekly?: number; monthly?: number | null; org?: number; member?: number | null };
  plan: Plan;
  organizationId: string | null;
  rollingMember: string | null;
  rollingKey: string | null;
  weekKey: string | null;
  monthKey: string | null;
  memberCapKey: string | null;
  /** True if Redis was unavailable and this reservation was allowed by fail-open — nothing to
   *  reconcile/refund later since nothing was actually incremented. */
  degraded: boolean;
};

export type QuotaCheckResult =
  | { allowed: true; reservation: Reservation }
  | { allowed: false; decision: QuotaDecision & { allowed: false }; resetAt: Date };

/**
 * Pre-flight check + reservation for one chat turn. Fails OPEN if Redis is unavailable (matching
 * every other Redis-backed limiter in this codebase — see rateLimit.ts/redisClient.ts) rather
 * than blocking chat entirely on an infra hiccup unrelated to the user's own usage.
 */
export async function checkAndReserve(userId: string, reserveTokens: number): Promise<QuotaCheckResult> {
  const effective = await resolveEffectivePlan(userId);
  const redis = await getRedisClient();
  const now = Date.now();
  const month = monthKey();

  if (!redis) {
    logger.warn("quota_check_degraded_no_redis", { userId });
    return {
      allowed: true,
      reservation: {
        reserveTokens,
        plan: effective.plan,
        organizationId: effective.enterprise?.organizationId ?? null,
        rollingMember: null,
        rollingKey: null,
        weekKey: null,
        monthKey: null,
        memberCapKey: null,
        degraded: true,
      },
    };
  }

  if (effective.enterprise) {
    const orgId = effective.enterprise.organizationId;
    const orgMonthKey = `quota:v2:orgmonth:${orgId}:${month}`;
    const memberCapKey = effective.customMonthlyCap != null ? `quota:v2:membermonth:${orgId}:${userId}:${month}` : null;

    const orgUsed = await counterGet(redis, orgMonthKey);
    const memberUsed = memberCapKey ? await counterGet(redis, memberCapKey) : 0;

    const decision = decideQuota({
      plan: effective.plan,
      reserveTokens,
      counters: { rollingTokens: 0, weeklyTokens: 0, monthlyTokens: 0 },
      enterprise: {
        pooledMonthlyTokens: effective.enterprise.pooledMonthlyTokens,
        orgMonthlyUsedTokens: orgUsed,
        memberMonthlyCap: effective.customMonthlyCap,
        memberMonthlyUsedTokens: memberUsed,
      },
    });
    if (!decision.allowed) {
      return { allowed: false, decision, resetAt: nextMonthlyReset() };
    }

    await counterIncr(redis, orgMonthKey, reserveTokens, 45 * 24 * 60 * 60);
    if (memberCapKey) await counterIncr(redis, memberCapKey, reserveTokens, 45 * 24 * 60 * 60);

    return {
      allowed: true,
      reservation: {
        userId,
        reserveTokens,
        charged: reserveTokens,
        progressMembers: [],
        limits: { org: effective.enterprise.pooledMonthlyTokens, member: effective.customMonthlyCap },
        plan: effective.plan,
        organizationId: orgId,
        rollingMember: null,
        rollingKey: null,
        weekKey: null,
        monthKey: orgMonthKey,
        memberCapKey,
        degraded: false,
      },
    };
  }

  const limits = PLAN_LIMITS[effective.plan];
  const eff = effectiveIndividualLimits(effective.plan, effective.customMonthlyCap, await planLimitsFor(effective.plan).catch(() => undefined));
  const rollingKey = `quota:v2:roll:${userId}`;
  const weekKey = `quota:v2:week:${userId}`;
  const monthTokenKey = eff.monthly != null ? `quota:v2:month:${userId}:${month}` : null;

  const [rollingUsed, weeklyUsed, monthlyUsed] = await Promise.all([
    rollingWindowUsed(redis, rollingKey, now),
    counterGet(redis, weekKey),
    monthTokenKey ? counterGet(redis, monthTokenKey) : Promise.resolve(0),
  ]);

  const decision = decideQuota({
    plan: effective.plan,
    reserveTokens,
    counters: { rollingTokens: rollingUsed, weeklyTokens: weeklyUsed, monthlyTokens: monthlyUsed },
    limitsOverride: eff,
  });
  if (!decision.allowed) {
    const resetAt =
      decision.reason === "rolling_window"
        ? await rollingResetAt(redis, rollingKey, now)
        : decision.reason === "monthly"
          ? nextMonthlyReset()
          : nextWeeklyReset();
    return { allowed: false, decision, resetAt };
  }

  const rollingMember = `${now}-${randomUUID()}:${reserveTokens}`;
  await redis.zAdd(rollingKey, [{ score: now, value: rollingMember }]);
  await redis.expire(rollingKey, ROLLING_WINDOW_SECONDS);
  await counterIncr(redis, weekKey, reserveTokens, WEEKLY_TTL_SECONDS);
  if (monthTokenKey) await counterIncr(redis, monthTokenKey, reserveTokens, 45 * 24 * 60 * 60);

  return {
    allowed: true,
    reservation: {
      userId,
      reserveTokens,
      charged: reserveTokens,
      progressMembers: [],
      limits: { rolling: eff.rolling, weekly: eff.weekly, monthly: eff.monthly },
      plan: effective.plan,
      organizationId: null,
      rollingMember,
      rollingKey,
      weekKey,
      monthKey: monthTokenKey,
      memberCapKey: null,
      degraded: false,
    },
  };
}

export type ProgressResult = { ok: true } | { ok: false; reason: "rolling_window" | "weekly" | "monthly" | "org_pool" | "member_cap" };

/**
 * Meters a turn WHILE it runs. The pre-flight reservation only covers the message itself; a long
 * turn (history, many tool rounds, a 100-round build) costs far more, and that used to be counted
 * only when the turn ended — so one turn could run well past the limit ("usage goes above 100%").
 * Callers report the turn's running total; the difference is charged atomically (INCRBY returns
 * the new total, so concurrent turns can't both slip past) and { ok: false } means stop now.
 * reconcileQuota later corrects the counters to the exact final figure.
 */
export async function chargeProgress(reservation: Reservation | undefined, totalTokensSoFar: number): Promise<ProgressResult> {
  if (!reservation || reservation.degraded || !reservation.limits) return { ok: true };
  const charged = reservation.charged ?? reservation.reserveTokens;
  const delta = Math.ceil(totalTokensSoFar - charged);
  if (delta <= 0) return { ok: true };
  const redis = await getRedisClient();
  if (!redis) return { ok: true };
  reservation.charged = charged + delta;
  const { limits } = reservation;
  if (reservation.memberCapKey) {
    const total = await redis.incrBy(reservation.memberCapKey, delta);
    if (limits.member != null && total > limits.member) return { ok: false, reason: "member_cap" };
  }
  if (reservation.organizationId && reservation.monthKey) {
    const total = await redis.incrBy(reservation.monthKey, delta);
    if (limits.org != null && total > limits.org) return { ok: false, reason: "org_pool" };
    return { ok: true };
  }
  const now = Date.now();
  if (reservation.rollingKey) {
    const member = `${now}-progress-${randomUUID()}:${delta}`;
    await redis.zAdd(reservation.rollingKey, [{ score: now, value: member }]);
    (reservation.progressMembers ??= []).push(member);
  }
  const [weekTotal, monthTotal, rollingTotal] = await Promise.all([
    reservation.weekKey ? redis.incrBy(reservation.weekKey, delta) : Promise.resolve(0),
    reservation.monthKey ? redis.incrBy(reservation.monthKey, delta) : Promise.resolve(0),
    reservation.rollingKey ? rollingWindowUsed(redis, reservation.rollingKey, now) : Promise.resolve(0),
  ]);
  if (limits.rolling != null && rollingTotal > limits.rolling) return { ok: false, reason: "rolling_window" };
  if (limits.weekly != null && weekTotal > limits.weekly) return { ok: false, reason: "weekly" };
  if (limits.monthly != null && monthTotal > limits.monthly) return { ok: false, reason: "monthly" };
  return { ok: true };
}

export const QUOTA_STOP_MESSAGE: Record<string, string> = {
  rolling_window: "You've reached your 5-hour usage limit, so I stopped here.",
  weekly: "You've reached your weekly usage limit, so I stopped here.",
  monthly: "You've reached your monthly usage limit, so I stopped here.",
  org_pool: "Your organization's monthly token pool is used up, so I stopped here.",
  member_cap: "You've reached the monthly cap your admin set, so I stopped here.",
};

/**
 * Post-completion reconciliation: corrects every counter incremented at reservation time by the
 * difference between what was reserved and what the provider actually reported (or 0 if the
 * message never actually reached a model at all — a full refund). Safe to call with
 * `actualTokens = reservation.reserveTokens` (a no-op) and safe on a degraded (no-Redis)
 * reservation (nothing to correct).
 */
export async function reconcileQuota(reservation: Reservation, actualTokens: number): Promise<void> {
  if (reservation.degraded) return;
  const charged = reservation.charged ?? reservation.reserveTokens;
  const delta = actualTokens - charged;
  if (delta === 0 && !reservation.progressMembers?.length) return;

  const redis = await getRedisClient();
  if (!redis) return; // Redis died between reserve and reconcile — nothing we can safely correct.

  if (reservation.rollingKey && reservation.rollingMember) {
    await redis.zRem(reservation.rollingKey, [reservation.rollingMember, ...(reservation.progressMembers ?? [])]);
    if (actualTokens > 0) {
      const [tsPart] = reservation.rollingMember.split("-");
      const score = Number(tsPart) || Date.now();
      // Unique per turn: two turns reconciling in the same millisecond with the same total would
      // otherwise collapse into one sorted-set member and under-count the window.
      await redis.zAdd(reservation.rollingKey, [{ score, value: `${tsPart}-corrected-${randomUUID()}:${actualTokens}` }]);
    }
  }
  if (delta !== 0) {
    if (reservation.weekKey) await redis.incrBy(reservation.weekKey, delta);
    if (reservation.monthKey) await redis.incrBy(reservation.monthKey, delta);
    if (reservation.memberCapKey) await redis.incrBy(reservation.memberCapKey, delta);
  }
  reservation.charged = actualTokens;
  reservation.progressMembers = [];
}

/** Fire-and-forget audit row for admin profitability reporting — distinct from usage_events'
 *  broader "token_usage" rows (kept for the existing monthly cost summary) in that this one
 *  carries the per-model input/output split and the original reservation for cross-checking. */
export type LedgerFeature = "chat" | "build" | "research" | "teamup" | "spark" | "automation" | "code" | "air";

/** Air Dots spends the same pool. The label is `air` so Finance can see it apart from chat and Build. */
export function ledgerFeatureFor(origin: string | null | undefined, otherwise: LedgerFeature): LedgerFeature {
  return origin === "air" ? "air" : otherwise;
}

export async function recordTokenLedger(
  userId: string,
  organizationId: string | null,
  providerSlug: string,
  modelId: string,
  usage: TokenUsage,
  reservedTokens: number,
  feature: LedgerFeature = "chat",
): Promise<void> {
  // Exact cost at today's price for this model (finance/pricing.ts); flagged when no price exists.
  const price = await priceUsage(providerSlug, modelId, usage);
  const pricedColumns = { cost_usd: price.costUsd, sell_inr: price.sellInr, priced: price.priced };
  const base = {
    user_id: userId,
    organization_id: organizationId,
    provider_slug: providerSlug,
    model_id: modelId,
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    // Both are already part of input_tokens above — these are just its cache breakdown, 0 when
    // the provider/call reported no prompt-cache activity (see providers/promptCache.ts).
    cached_tokens: usage.cachedTokens ?? 0,
    cache_write_tokens: usage.cacheWriteTokens ?? 0,
    estimated_cost_cents: Math.round(price.costUsd * 100 * 100) / 100,
    reserved_tokens: reservedTokens,
  };
  let { error } = await supabaseAdmin.from("token_ledger").insert({ ...base, ...pricedColumns, feature });
  // A server deployed before migration 0048 must still record usage (quota + audit rely on it).
  if (error && /feature/.test(error.message)) ({ error } = await supabaseAdmin.from("token_ledger").insert({ ...base, ...pricedColumns }));
  // A server deployed before migration 0040 ran must still record usage (quota + audit rely on it).
  if (error && /cost_usd|sell_inr|priced/.test(error.message)) ({ error } = await supabaseAdmin.from("token_ledger").insert(base));
  if (error) logger.warn("token_ledger_insert_failed", { userId, error: error.message });
}

/** Whether `plan` (individual) or enterprise membership can use a model gated at `minTier`. */
export async function canUseModelTier(userId: string, minTier: Plan): Promise<boolean> {
  if (minTier === "free") return true;
  const effective = await resolveEffectivePlan(userId);
  if (effective.enterprise) return true; // spec: enterprise gets "global access to all models"
  return planSatisfiesTier(effective.plan, minTier);
}

export type QuotaStatus = {
  plan: Plan;
  isEnterprise: boolean;
  rolling: { used: number; limit: number; resetAt: string } | null;
  weekly: { used: number; limit: number; resetAt: string };
  monthly: { used: number; limit: number; resetAt: string } | null;
  org: { used: number; limit: number; seatCount: number; resetAt: string } | null;
  memberCap: { used: number; limit: number } | null;
};

/**
 * What a usage meter shows for a counter: never below 0 and never above the limit. A counter CAN go
 * negative — a bonus grant decrements it on purpose (headroom), and a refund can land on a key that
 * already rolled over — and the raw value used to reach the client as "-12% used".
 */
export function meterValue(used: number, limit: number): number {
  return Math.max(0, Math.min(Number.isFinite(used) ? used : 0, limit));
}

/**
 * Admin "master control" — grants extra headroom for the CURRENT period by decrementing
 * whichever counter(s) the user's plan actually enforces (rolling window excluded: it's a
 * moving 5h window, not a fixed bucket, so a bonus there would just get pruned away within
 * hours — the weekly/monthly counters are where a bonus persists meaningfully).
 */
export async function grantBonusTokens(userId: string, tokens: number): Promise<void> {
  const effective = await resolveEffectivePlan(userId);
  const redis = await getRedisClient();
  if (!redis) throw new Error("Redis is not configured — can't grant bonus tokens");
  const month = monthKey();

  if (effective.enterprise) {
    await redis.incrBy(`quota:v2:orgmonth:${effective.enterprise.organizationId}:${month}`, -tokens);
    return;
  }
  await redis.incrBy(`quota:v2:week:${userId}`, -tokens);
  if (PLAN_LIMITS[effective.plan].monthlyTokens != null) {
    await redis.incrBy(`quota:v2:month:${userId}:${month}`, -tokens);
  }
}

/** Admin "master control" — wipes this user's current-period counters early (weekly + monthly;
 *  the rolling window is left alone since it self-clears within 5 hours regardless). */
export async function resetUserQuotaNow(userId: string): Promise<void> {
  const redis = await getRedisClient();
  if (!redis) throw new Error("Redis is not configured — can't reset quota");
  const month = monthKey();
  await redis.del([`quota:v2:week:${userId}`, `quota:v2:month:${userId}:${month}`, `quota:v2:roll:${userId}`]);
}

/** Full status for the Usage settings panel and the 50/80/90/100% threshold toasts. */
export async function getQuotaStatus(userId: string): Promise<QuotaStatus> {
  const effective = await resolveEffectivePlan(userId);
  const redis = await getRedisClient();
  const now = Date.now();
  const month = monthKey();

  if (effective.enterprise) {
    const orgId = effective.enterprise.organizationId;
    const orgMonthKey = `quota:v2:orgmonth:${orgId}:${month}`;
    const memberCapKey = effective.customMonthlyCap != null ? `quota:v2:membermonth:${orgId}:${userId}:${month}` : null;
    const orgUsed = redis ? await counterGet(redis, orgMonthKey) : 0;
    const memberUsed = redis && memberCapKey ? await counterGet(redis, memberCapKey) : 0;
    return {
      plan: effective.plan,
      isEnterprise: true,
      rolling: null,
      weekly: { used: 0, limit: 0, resetAt: nextWeeklyReset().toISOString() },
      monthly: null,
      org: {
        used: meterValue(orgUsed, effective.enterprise.pooledMonthlyTokens),
        limit: effective.enterprise.pooledMonthlyTokens,
        seatCount: effective.enterprise.seatCount,
        resetAt: nextMonthlyReset().toISOString(),
      },
      memberCap: effective.customMonthlyCap != null ? { used: meterValue(memberUsed, effective.customMonthlyCap), limit: effective.customMonthlyCap } : null,
    };
  }

  const limits = PLAN_LIMITS[effective.plan];
  const eff = effectiveIndividualLimits(effective.plan, effective.customMonthlyCap, await planLimitsFor(effective.plan).catch(() => undefined));
  const rollingKey = `quota:v2:roll:${userId}`;
  const weekKey = `quota:v2:week:${userId}`;
  const monthTokenKey = eff.monthly != null ? `quota:v2:month:${userId}:${month}` : null;

  const [rollingUsed, weeklyUsed, monthlyUsed] = redis
    ? await Promise.all([
        rollingWindowUsed(redis, rollingKey, now),
        counterGet(redis, weekKey),
        monthTokenKey ? counterGet(redis, monthTokenKey) : Promise.resolve(0),
      ])
    : [0, 0, 0];

  return {
    plan: effective.plan,
    isEnterprise: false,
    // Clamped for display: the counters can sit a few tokens past a limit (the turn that crossed it
    // is stopped, not undone) — the meter should read "100%", never "103%".
    rolling: {
      used: meterValue(rollingUsed, eff.rolling),
      limit: eff.rolling,
      resetAt: (redis ? await rollingResetAt(redis, rollingKey, now) : new Date(now + limits.rollingWindowSeconds * 1000)).toISOString(),
    },
    weekly: { used: meterValue(weeklyUsed, eff.weekly), limit: eff.weekly, resetAt: nextWeeklyReset().toISOString() },
    monthly:
      eff.monthly != null
        ? { used: meterValue(monthlyUsed, eff.monthly), limit: eff.monthly, resetAt: nextMonthlyReset().toISOString() }
        : null,
    org: null,
    memberCap: null,
  };
}
