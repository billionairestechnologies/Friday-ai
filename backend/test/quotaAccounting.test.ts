import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setRedisClientForTests } from "../src/services/redisClient.js";
import { chargeProgress, checkAndReserve, reconcileQuota, getQuotaStatus } from "../src/services/quota/tokenQuotaService.js";
import { PLAN_LIMITS, ROLLING_WINDOW_SECONDS } from "../src/services/quota/tierConfig.js";

/** Just enough of the redis client for the quota counters (strings + sorted sets). */
class FakeRedis {
  kv = new Map<string, number>();
  z = new Map<string, { score: number; value: string }[]>();
  async get(k: string) { return this.kv.has(k) ? String(this.kv.get(k)) : null; }
  async incrBy(k: string, by: number) { const v = (this.kv.get(k) ?? 0) + by; this.kv.set(k, v); return v; }
  async pTTL() { return 1000; }
  async expire() { return true; }
  async del(keys: string[]) { for (const k of keys) { this.kv.delete(k); this.z.delete(k); } return keys.length; }
  async zAdd(k: string, items: { score: number; value: string }[]) { this.z.set(k, [...(this.z.get(k) ?? []), ...items]); return items.length; }
  async zRem(k: string, values: string[]) { this.z.set(k, (this.z.get(k) ?? []).filter((m) => !values.includes(m.value))); return values.length; }
  async zRemRangeByScore(k: string, _min: string, max: number) { this.z.set(k, (this.z.get(k) ?? []).filter((m) => m.score > max)); return 0; }
  async zRangeByScore(k: string) { return (this.z.get(k) ?? []).map((m) => m.value); }
  async zRangeWithScores(k: string, start: number, stop: number) { return [...(this.z.get(k) ?? [])].sort((a, b) => a.score - b.score).slice(start, stop + 1); }
}

let redis: FakeRedis;
beforeEach(() => { redis = new FakeRedis(); setRedisClientForTests(redis); });

// Unknown user + placeholder Supabase → resolves as Free with code-default limits.
const user = "00000000-0000-0000-0000-000000000001";
const FREE = PLAN_LIMITS.free;

test("a failed turn is fully refunded: charged progress is returned on reconcile(0)", async () => {
  const res = await checkAndReserve(user, 100);
  assert.equal(res.allowed, true);
  if (!res.allowed) return;
  assert.deepEqual(await chargeProgress(res.reservation, 1_000), { ok: true });
  assert.equal((await getQuotaStatus(user)).weekly.used, 1_000);
  await reconcileQuota(res.reservation, 0); // the turn failed before any answer
  const status = await getQuotaStatus(user);
  assert.equal(status.weekly.used, 0);
  assert.equal(status.rolling?.used, 0);
});

test("a finished turn is corrected to its real cost, not the estimate", async () => {
  const res = await checkAndReserve(user, 500);
  if (!res.allowed) return assert.fail("should be allowed");
  await chargeProgress(res.reservation, 900);
  await reconcileQuota(res.reservation, 700);
  const status = await getQuotaStatus(user);
  assert.equal(status.weekly.used, 700);
  assert.equal(status.rolling?.used, 700);
});

test("a long turn is stopped the moment it crosses the 5-hour window, and the next message is refused", async () => {
  const res = await checkAndReserve(user, 100);
  if (!res.allowed) return assert.fail("should be allowed");
  const stop = await chargeProgress(res.reservation, FREE.rollingWindowTokens + 1);
  assert.deepEqual(stop, { ok: false, reason: "rolling_window" });
  // The turn keeps what it really spent; the next message can't start inside the window.
  await reconcileQuota(res.reservation, FREE.rollingWindowTokens + 1);
  const next = await checkAndReserve(user, 100);
  assert.equal(next.allowed, false);
  if (!next.allowed) assert.equal(next.decision.reason, "rolling_window");
});

test("rolling reset time is when the OLDEST usage rolls off, not now + 5 h", async () => {
  const res = await checkAndReserve(user, 100);
  if (!res.allowed) return assert.fail("should be allowed");
  const oldest = Date.now() - 3 * 3600_000;
  redis.z.set(res.reservation.rollingKey!, [{ score: oldest, value: `${oldest}-x:50` }, ...(redis.z.get(res.reservation.rollingKey!) ?? [])]);
  const status = await getQuotaStatus(user);
  assert.equal(new Date(status.rolling!.resetAt).getTime(), oldest + ROLLING_WINDOW_SECONDS * 1000);
});

test("concurrent turns can't both slip past the limit", async () => {
  const half = Math.floor(FREE.rollingWindowTokens * 0.6);
  const [a, b] = await Promise.all([checkAndReserve(user, 100), checkAndReserve(user, 100)]);
  if (!a.allowed || !b.allowed) return assert.fail("both start");
  const [ra, rb] = await Promise.all([chargeProgress(a.reservation, half), chargeProgress(b.reservation, half)]);
  assert.ok(ra.ok !== rb.ok || (!ra.ok && !rb.ok), "at least one is stopped once the shared window is exceeded");
});
