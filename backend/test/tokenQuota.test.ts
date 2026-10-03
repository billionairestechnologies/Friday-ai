import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideQuota,
  ENTERPRISE_MIN_SEATS,
  ENTERPRISE_TOKENS_PER_SEAT,
  nextMonthlyReset,
  nextWeeklyReset,
  PLAN_LIMITS,
  planSatisfiesTier,
} from "../src/services/quota/tierConfig.js";
import { chargeProgress, effectiveIndividualLimits, estimateReservationTokens } from "../src/services/quota/tokenQuotaService.js";

test("free plan allows spend under every ceiling", () => {
  const decision = decideQuota({
    plan: "free",
    reserveTokens: 1_000,
    counters: { rollingTokens: 0, weeklyTokens: 0, monthlyTokens: 0 },
  });
  assert.equal(decision.allowed, true);
});

test("free plan blocks on the 5-hour rolling window before the weekly cap", () => {
  const decision = decideQuota({
    plan: "free",
    reserveTokens: 5_000,
    counters: { rollingTokens: PLAN_LIMITS.free.rollingWindowTokens - 1, weeklyTokens: 0, monthlyTokens: 0 },
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.reason, "rolling_window");
});

test("free plan blocks on the weekly ceiling once rolling window has headroom", () => {
  const decision = decideQuota({
    plan: "free",
    reserveTokens: 1_000,
    counters: { rollingTokens: 0, weeklyTokens: PLAN_LIMITS.free.weeklyTokens - 1, monthlyTokens: 0 },
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.reason, "weekly");
});

test("free plan has no monthly ceiling to enforce", () => {
  const decision = decideQuota({
    plan: "free",
    reserveTokens: 1,
    counters: { rollingTokens: 0, weeklyTokens: 0, monthlyTokens: Number.MAX_SAFE_INTEGER },
  });
  assert.equal(decision.allowed, true);
});

test("pro plan blocks on its monthly backstop even with weekly/rolling headroom", () => {
  const decision = decideQuota({
    plan: "pro",
    reserveTokens: 1_000,
    counters: { rollingTokens: 0, weeklyTokens: 0, monthlyTokens: PLAN_LIMITS.pro.monthlyTokens! - 1 },
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.reason, "monthly");
});

test("enterprise member bypasses the rolling window and plan table entirely", () => {
  const decision = decideQuota({
    plan: "free", // deliberately mismatched — must be ignored once `enterprise` is present
    reserveTokens: 10_000_000,
    counters: { rollingTokens: 999_999_999, weeklyTokens: 999_999_999, monthlyTokens: 999_999_999 },
    enterprise: { pooledMonthlyTokens: 35_000_000 * ENTERPRISE_MIN_SEATS, orgMonthlyUsedTokens: 0 },
  });
  assert.equal(decision.allowed, true);
});

test("enterprise member blocked once the shared org pool is exhausted", () => {
  const pooled = ENTERPRISE_TOKENS_PER_SEAT * ENTERPRISE_MIN_SEATS;
  const decision = decideQuota({
    plan: "premium",
    reserveTokens: 1,
    counters: { rollingTokens: 0, weeklyTokens: 0, monthlyTokens: 0 },
    enterprise: { pooledMonthlyTokens: pooled, orgMonthlyUsedTokens: pooled },
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.reason, "org_pool");
});

test("enterprise member's personal cap is checked ahead of the shared pool", () => {
  const decision = decideQuota({
    plan: "premium",
    reserveTokens: 100,
    counters: { rollingTokens: 0, weeklyTokens: 0, monthlyTokens: 0 },
    enterprise: {
      pooledMonthlyTokens: 35_000_000 * ENTERPRISE_MIN_SEATS,
      orgMonthlyUsedTokens: 0,
      memberMonthlyCap: 500,
      memberMonthlyUsedTokens: 450,
    },
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.reason, "member_cap");
});

test("planSatisfiesTier respects free < pro < premium ordering", () => {
  assert.equal(planSatisfiesTier("free", "free"), true);
  assert.equal(planSatisfiesTier("free", "pro"), false);
  assert.equal(planSatisfiesTier("pro", "free"), true);
  assert.equal(planSatisfiesTier("pro", "premium"), false);
  assert.equal(planSatisfiesTier("premium", "premium"), true);
});

test("estimateReservationTokens (credits) scales with prompt length and adds the completion buffer", () => {
  const short = estimateReservationTokens(40, 800);
  const long = estimateReservationTokens(4_000, 800);
  // 10 prompt tokens ≈ 1 credit at $1/M, plus 800 completion tokens at $4/M ≈ 320 credits.
  assert.ok(short >= 320);
  assert.ok(long > short);
});

test("nextWeeklyReset always lands on a future Monday 00:00 UTC", () => {
  const from = new Date("2026-09-18T12:00:00Z"); // a Friday
  const reset = nextWeeklyReset(from);
  assert.equal(reset.getUTCDay(), 1);
  assert.equal(reset.getUTCHours(), 0);
  assert.ok(reset.getTime() > from.getTime());
});

test("nextMonthlyReset is the 1st of next UTC month", () => {
  const from = new Date("2026-09-18T12:00:00Z");
  const reset = nextMonthlyReset(from);
  assert.equal(reset.getUTCMonth(), 9); // October, 0-indexed
  assert.equal(reset.getUTCDate(), 1);
});

test("a personal monthly cap replaces the plan month and scales the other windows up, never down", () => {
  assert.deepEqual(effectiveIndividualLimits("pro", null), {
    rolling: PLAN_LIMITS.pro.rollingWindowTokens,
    weekly: PLAN_LIMITS.pro.weeklyTokens,
    monthly: PLAN_LIMITS.pro.monthlyTokens,
  });
  const big = effectiveIndividualLimits("pro", PLAN_LIMITS.pro.monthlyTokens! * 3);
  assert.equal(big.monthly, PLAN_LIMITS.pro.monthlyTokens! * 3);
  assert.equal(big.weekly, PLAN_LIMITS.pro.weeklyTokens * 3);
  assert.equal(big.rolling, PLAN_LIMITS.pro.rollingWindowTokens * 3);
  // A cap below the plan's month tightens only the month (e.g. a trial grant).
  const small = effectiveIndividualLimits("pro", 200_000);
  assert.equal(small.monthly, 200_000);
  assert.equal(small.weekly, PLAN_LIMITS.pro.weeklyTokens);
  // Free has no monthly ceiling of its own — a cap still becomes one.
  assert.equal(effectiveIndividualLimits("free", 400_000).monthly, 400_000);
});

test("decideQuota enforces an override's monthly cap", () => {
  const decision = decideQuota({
    plan: "free",
    reserveTokens: 1_000,
    counters: { rollingTokens: 0, weeklyTokens: 0, monthlyTokens: 99_500 },
    limitsOverride: { rolling: 50_000, weekly: 250_000, monthly: 100_000 },
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.reason, "monthly");
});

test("chargeProgress is a no-op without a live reservation (degraded / no Redis)", async () => {
  assert.deepEqual(await chargeProgress(undefined, 10_000), { ok: true });
  assert.deepEqual(
    await chargeProgress({ reserveTokens: 100, plan: "free", organizationId: null, rollingMember: null, rollingKey: null, weekKey: null, monthKey: null, memberCapKey: null, degraded: true }, 10_000),
    { ok: true },
  );
});
