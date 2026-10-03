import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDITS_PER_USD, creditsForInputTokens, creditsForUsage, fallbackRates, type MeterRates } from "../src/services/quota/meter.js";
import { PLAN_LIMITS } from "../src/services/quota/tierConfig.js";
import type { TokenUsage } from "../src/services/tokenUsage.js";

// Sonnet-like prices: $3 in / $15 out per 1M, cache read 0.1x, cache write 1.25x.
const sonnet: MeterRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const usage = (u: Partial<TokenUsage>): TokenUsage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0, ...u });

test("credits are real cost: $1 of usage = CREDITS_PER_USD", () => {
  assert.equal(creditsForUsage(usage({ promptTokens: 1_000_000 }), { ...sonnet, input: 1 }), CREDITS_PER_USD);
});

test("cache reads cost a tenth: a cache-heavy Build turn is priced by cost, not by its raw token count", () => {
  // The incident: ~1.2M tokens in one Build turn, most of it re-read from cache.
  const build = usage({ promptTokens: 1_140_000, cachedTokens: 1_000_000, completionTokens: 60_000, totalTokens: 1_200_000 });
  // 140k fresh × $3 + 1M cached × $0.3 + 60k out × $15 = 0.42 + 0.30 + 0.90 = $1.62
  assert.equal(creditsForUsage(build, sonnet), Math.ceil(1.62 * CREDITS_PER_USD));
});

test("an expensive model drains more than a cheap one for the same tokens", () => {
  const haiku: MeterRates = { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 };
  const u = usage({ promptTokens: 10_000, completionTokens: 1_000 });
  assert.ok(creditsForUsage(u, sonnet) > creditsForUsage(u, haiku) * 3);
});

test("cache writes carry a premium and cached/written are clamped to the prompt", () => {
  assert.equal(creditsForUsage(usage({ promptTokens: 1_000_000, cacheWriteTokens: 1_000_000 }), sonnet), Math.ceil(3.75 * CREDITS_PER_USD));
  assert.equal(creditsForUsage(usage({ promptTokens: 1000, cachedTokens: 9_999_999 }), sonnet), Math.ceil((1000 * 0.3 * CREDITS_PER_USD) / 1_000_000));
});

test("a real call is never metered as free; an empty one is", () => {
  assert.equal(creditsForUsage(usage({ promptTokens: 1 }), sonnet), 1);
  assert.equal(creditsForUsage(usage({}), sonnet), 0);
});

test("pre-flight estimate prices fresh input", () => {
  assert.equal(creditsForInputTokens(1_000_000, { ...sonnet, input: 1 }), CREDITS_PER_USD);
});

test("provider fallback rates are sane", () => {
  const r = fallbackRates("anthropic");
  assert.ok(r.output >= r.input && r.cacheRead < r.input && r.cacheWrite > r.input);
});

test("default plan windows scale with the plan and are in credits", () => {
  assert.ok(PLAN_LIMITS.free.rollingWindowTokens < PLAN_LIMITS.pro.rollingWindowTokens);
  assert.ok(PLAN_LIMITS.pro.rollingWindowTokens < PLAN_LIMITS.premium.rollingWindowTokens);
  assert.equal(PLAN_LIMITS.pro.rollingWindowTokens, 0.6 * CREDITS_PER_USD); // Pro's 5-hour window is $0.60 of real cost
});
