import { getRedisClient } from "../redisClient.js";
import { consumeDailyAllowance, entitlementsFor } from "../quota/entitlements.js";
import { HttpError } from "../../middleware/errorHandler.js";

/**
 * The daily awake cap for Air Dots machines (Pro 20 min, Premium 45 min — the airAwakeMinutes
 * entitlement). E2B bills while a machine is awake, so what counts is how far each keep-alive pushes
 * the machine's end time: we remember "awake until" per machine and charge only the new minutes.
 * Before, only a brand-new machine was charged (8 min), so a loop reconnecting to one machine could
 * keep it awake all day for free.
 */

export const AIR_IDLE_MS = 8 * 60_000;

/** Minutes to charge when the machine's end moves from `prevUntil` to `nextUntil`. Pure; tested. */
export function minutesToCharge(prevUntil: number, nextUntil: number, now: number): number {
  const from = Math.max(now, prevUntil);
  return nextUntil > from ? Math.ceil((nextUntil - from) / 60_000) : 0;
}

/**
 * Charge (or refuse) keeping an Air Dots machine awake for another AIR_IDLE_MS. `machine` is a
 * stable key: "build:<conversation>" or "browser:<conversation>". Throws 402 when today's minutes are
 * gone — the work is kept (the machine pauses) and Friday says the cap stopped it.
 */
export async function chargeAwake(userId: string, machine: string, extendMs = AIR_IDLE_MS): Promise<void> {
  const cap = (await entitlementsFor(userId)).airAwakeMinutes;
  if (cap <= 0) throw new HttpError(402, "Air Dots computer time isn't on your plan.");
  const redis = await getRedisClient().catch(() => null);
  const now = Date.now();
  const next = now + extendMs;
  const key = `air:awake:${machine}`;
  const prev = redis ? Number((await redis.get(key)) ?? 0) : 0;
  const minutes = minutesToCharge(prev, next, now);
  if (minutes > 0) {
    const allowance = await consumeDailyAllowance(userId, "air_awake", cap, minutes);
    if (!allowance.ok) throw new HttpError(402, "Today's Air Dots computer time is used up. The work is saved; it carries on tomorrow (resets at midnight UTC).");
  }
  if (redis) await redis.set(key, String(next), { PX: extendMs + 60_000 });
}
