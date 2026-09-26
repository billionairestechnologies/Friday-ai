import { randomUUID } from "node:crypto";
import { memoAsync } from "../../utils/ttlMemo.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { getRedisClient } from "../redisClient.js";
import { logger } from "../../utils/logger.js";
import { estimateCostCents, type TokenUsage } from "../tokenUsage.js";
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
      enterprise = {
        organizationId: enterpriseRow.organization_id as string,
        seatCount,
        pooledMonthlyTokens: resolved.pooled_monthly_tokens ?? seatCount * ENTERPRISE_TOKENS_PER_SEAT,
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

/** Rough pre-flight estimate: ~4 chars/token for the prompt, plus a fixed completion buffer,
 *  reserved before dispatch and corrected to the real count once the provider reports usage. */
export function estimateReservationTokens(promptChars: number, completionBufferTokens = 800): number {
  return Math.max(1, Math.ceil(promptChars / 4)) + completionBufferTokens;
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

export type Reservation = {
  reserveTokens: number;
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
    const orgMonthKey = `quota:orgmonth:${orgId}:${month}`;
    const memberCapKey = effective.customMonthlyCap != null ? `quota:membermonth:${orgId}:${userId}:${month}` : null;

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
        reserveTokens,
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
  const rollingKey = `quota:roll:${userId}`;
  const weekKey = `quota:week:${userId}`;
  const monthTokenKey = limits.monthlyTokens != null ? `quota:month:${userId}:${month}` : null;

  const [rollingUsed, weeklyUsed, monthlyUsed] = await Promise.all([
    rollingWindowUsed(redis, rollingKey, now),
    counterGet(redis, weekKey),
    monthTokenKey ? counterGet(redis, monthTokenKey) : Promise.resolve(0),
  ]);

  const decision = decideQuota({
    plan: effective.plan,
    reserveTokens,
    counters: { rollingTokens: rollingUsed, weeklyTokens: weeklyUsed, monthlyTokens: monthlyUsed },
  });
  if (!decision.allowed) {
    const resetAt =
      decision.reason === "rolling_window"
        ? new Date(now + limits.rollingWindowSeconds * 1000)
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
      reserveTokens,
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

/**
 * Post-completion reconciliation: corrects every counter incremented at reservation time by the
 * difference between what was reserved and what the provider actually reported (or 0 if the
 * message never actually reached a model at all — a full refund). Safe to call with
 * `actualTokens = reservation.reserveTokens` (a no-op) and safe on a degraded (no-Redis)
 * reservation (nothing to correct).
 */
export async function reconcileQuota(reservation: Reservation, actualTokens: number): Promise<void> {
  if (reservation.degraded) return;
  const delta = actualTokens - reservation.reserveTokens;
  if (delta === 0) return;

  const redis = await getRedisClient();
  if (!redis) return; // Redis died between reserve and reconcile — nothing we can safely correct.

  if (reservation.rollingKey && reservation.rollingMember) {
    await redis.zRem(reservation.rollingKey, reservation.rollingMember);
    if (actualTokens > 0) {
      const [tsPart] = reservation.rollingMember.split("-");
      const score = Number(tsPart) || Date.now();
      await redis.zAdd(reservation.rollingKey, [{ score, value: `${tsPart}-corrected:${actualTokens}` }]);
    }
  }
  if (reservation.weekKey) await redis.incrBy(reservation.weekKey, delta);
  if (reservation.monthKey) await redis.incrBy(reservation.monthKey, delta);
  if (reservation.memberCapKey) await redis.incrBy(reservation.memberCapKey, delta);
}

/** Fire-and-forget audit row for admin profitability reporting — distinct from usage_events'
 *  broader "token_usage" rows (kept for the existing monthly cost summary) in that this one
 *  carries the per-model input/output split and the original reservation for cross-checking. */
export async function recordTokenLedger(
  userId: string,
  organizationId: string | null,
  providerSlug: string,
  modelId: string,
  usage: TokenUsage,
  reservedTokens: number,
): Promise<void> {
  const { error } = await supabaseAdmin.from("token_ledger").insert({
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
    estimated_cost_cents: estimateCostCents(providerSlug, usage),
    reserved_tokens: reservedTokens,
  });
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
    await redis.incrBy(`quota:orgmonth:${effective.enterprise.organizationId}:${month}`, -tokens);
    return;
  }
  await redis.incrBy(`quota:week:${userId}`, -tokens);
  if (PLAN_LIMITS[effective.plan].monthlyTokens != null) {
    await redis.incrBy(`quota:month:${userId}:${month}`, -tokens);
  }
}

/** Admin "master control" — wipes this user's current-period counters early (weekly + monthly;
 *  the rolling window is left alone since it self-clears within 5 hours regardless). */
export async function resetUserQuotaNow(userId: string): Promise<void> {
  const redis = await getRedisClient();
  if (!redis) throw new Error("Redis is not configured — can't reset quota");
  const month = monthKey();
  await redis.del([`quota:week:${userId}`, `quota:month:${userId}:${month}`, `quota:roll:${userId}`]);
}

/** Full status for the Usage settings panel and the 50/80/90/100% threshold toasts. */
export async function getQuotaStatus(userId: string): Promise<QuotaStatus> {
  const effective = await resolveEffectivePlan(userId);
  const redis = await getRedisClient();
  const now = Date.now();
  const month = monthKey();

  if (effective.enterprise) {
    const orgId = effective.enterprise.organizationId;
    const orgMonthKey = `quota:orgmonth:${orgId}:${month}`;
    const memberCapKey = effective.customMonthlyCap != null ? `quota:membermonth:${orgId}:${userId}:${month}` : null;
    const orgUsed = redis ? await counterGet(redis, orgMonthKey) : 0;
    const memberUsed = redis && memberCapKey ? await counterGet(redis, memberCapKey) : 0;
    return {
      plan: effective.plan,
      isEnterprise: true,
      rolling: null,
      weekly: { used: 0, limit: 0, resetAt: nextWeeklyReset().toISOString() },
      monthly: null,
      org: {
        used: orgUsed,
        limit: effective.enterprise.pooledMonthlyTokens,
        seatCount: effective.enterprise.seatCount,
        resetAt: nextMonthlyReset().toISOString(),
      },
      memberCap: effective.customMonthlyCap != null ? { used: memberUsed, limit: effective.customMonthlyCap } : null,
    };
  }

  const limits = PLAN_LIMITS[effective.plan];
  const rollingKey = `quota:roll:${userId}`;
  const weekKey = `quota:week:${userId}`;
  const monthTokenKey = limits.monthlyTokens != null ? `quota:month:${userId}:${month}` : null;

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
    rolling: {
      used: rollingUsed,
      limit: limits.rollingWindowTokens,
      resetAt: new Date(now + limits.rollingWindowSeconds * 1000).toISOString(),
    },
    weekly: { used: weeklyUsed, limit: limits.weeklyTokens, resetAt: nextWeeklyReset().toISOString() },
    monthly:
      limits.monthlyTokens != null
        ? { used: monthlyUsed, limit: limits.monthlyTokens, resetAt: nextMonthlyReset().toISOString() }
        : null,
    org: null,
    memberCap: null,
  };
}
