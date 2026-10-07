import { supabaseAdmin } from "../../config/supabase.js";
import { memoAsync } from "../../utils/ttlMemo.js";
import { getRedisClient } from "../redisClient.js";
import { DEFAULT_ENTITLEMENTS, getCatalogPlan, mergeEntitlements, type CatalogPlanId, type Entitlements } from "./planCatalog.js";
import { resolveEffectivePlan } from "./tokenQuotaService.js";

/**
 * What THIS person can use right now: their plan's entitlements (catalog-edited), then their
 * enterprise org's overrides, then whatever a package or grant gave them personally. Every feature
 * gate (Build Mode, Deep Research, documents, skills, Library, Team Up, MCP, automations, support
 * priority) asks here, so a package an admin builds in the console actually powers the product.
 */

async function overridesFor(userId: string, organizationId: string | null) {
  // Separate from resolveEffectivePlan on purpose: before migration 0033 these columns don't exist,
  // and a failed select there would read as "free plan" for everyone. Here it just means no overrides.
  const [profile, org] = await Promise.all([
    supabaseAdmin.from("profiles").select("entitlements").eq("id", userId).maybeSingle(),
    organizationId ? supabaseAdmin.from("organizations").select("entitlements").eq("id", organizationId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  return {
    personal: (profile.data?.entitlements as Partial<Entitlements> | undefined) ?? null,
    organization: (org.data?.entitlements as Partial<Entitlements> | undefined) ?? null,
  };
}

async function resolveEntitlementsUncached(userId: string): Promise<{ plan: CatalogPlanId; entitlements: Entitlements }> {
  const effective = await resolveEffectivePlan(userId);
  const plan: CatalogPlanId = effective.enterprise ? "enterprise" : effective.plan;
  const [catalogPlan, overrides] = await Promise.all([
    getCatalogPlan(plan),
    overridesFor(userId, effective.enterprise?.organizationId ?? null).catch(() => ({ personal: null, organization: null })),
  ]);
  return { plan, entitlements: mergeEntitlements(catalogPlan.entitlements, overrides.organization, overrides.personal) };
}

export const resolveEntitlements = memoAsync(30_000, resolveEntitlementsUncached, (userId) => userId);

/** Never throws — a lookup failure degrades to the Free plan's entitlements, not a broken request. */
export async function entitlementsFor(userId: string): Promise<Entitlements> {
  return (await resolveEntitlements(userId).catch(() => null))?.entitlements ?? DEFAULT_ENTITLEMENTS.free;
}

function secondsUntilUtcMidnight(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Takes one unit of a per-day allowance (Deep Research runs, generated documents…). Atomic: INCR
 * first, give it back if that went over — two parallel requests can't both take the last unit.
 * Fails open without Redis, same as the token quota (a Redis outage must not take features down).
 */
export async function consumeDailyAllowance(userId: string, feature: string, limit: number): Promise<{ ok: boolean; used: number; limit: number }> {
  if (limit <= 0) return { ok: false, used: 0, limit };
  const redis = await getRedisClient().catch(() => null);
  if (!redis) return { ok: true, used: 0, limit };
  const day = new Date().toISOString().slice(0, 10);
  const key = `allow:${feature}:${userId}:${day}`;
  const used = await redis.incr(key);
  if (used === 1) await redis.expire(key, secondsUntilUtcMidnight());
  if (used > limit) {
    await redis.decr(key);
    return { ok: false, used: limit, limit };
  }
  return { ok: true, used, limit };
}

/** Gives a unit back (the work it paid for didn't happen). */
export async function refundDailyAllowance(userId: string, feature: string): Promise<void> {
  const redis = await getRedisClient().catch(() => null);
  if (!redis) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = `allow:${feature}:${userId}:${day}`;
  const value = Number((await redis.get(key)) ?? 0);
  if (value > 0) await redis.decr(key);
}
