import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonthsUtc, billableTokens, CACHE_READ_WEIGHT, percentUsed, periodFor, remainingOf, snapshotFromRow } from "../src/services/quota/allowance.js";
import { normalizeUsage, usageDelta, usageFromGemini, usageFromOpenAi, type TokenUsage } from "../src/services/tokenUsage.js";
import { PLAN_ALLOWANCES, ENTERPRISE_TOKENS_PER_SEAT } from "../src/services/quota/tierConfig.js";

const u = (promptTokens: number, completionTokens: number, extra: Partial<TokenUsage> = {}): TokenUsage => ({ promptTokens, completionTokens, totalTokens: 0, ...extra });

test("plain input + output count one-for-one", () => {
  assert.equal(billableTokens(u(1_000, 250)), 1_250);
});

test("a provider total is never added on top of its parts (no double count)", () => {
  // OpenAI-style report: total = prompt + completion. Counting total as well would make this 2,500.
  const usage = usageFromOpenAi({ prompt_tokens: 1_000, completion_tokens: 250, total_tokens: 1_250 } as never);
  assert.equal(usage.totalTokens, 1_250);
  assert.equal(billableTokens(usage), 1_250);
});

test("cache reads count at a tenth, cache writes in full, and neither is counted twice", () => {
  // 10,000 prompt tokens of which 9,000 were cache reads and 500 cache writes; 200 output.
  const usage = u(10_000, 200, { cachedTokens: 9_000, cacheWriteTokens: 500 });
  const expected = 500 /* fresh */ + 500 /* writes */ + 200 /* output */ + Math.ceil(9_000 * CACHE_READ_WEIGHT);
  assert.equal(billableTokens(usage), expected);
  assert.equal(expected, 2_100);
});

test("reasoning tokens are part of output, never added again", () => {
  // OpenAI reports reasoning inside completion_tokens.
  const openai = usageFromOpenAi({ prompt_tokens: 100, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 } });
  assert.equal(openai.completionTokens, 900);
  assert.equal(openai.reasoningTokens, 700);
  assert.equal(billableTokens(openai), 1_000);
  // Gemini reports thinking SEPARATELY (thoughtsTokenCount) — it must be added to output once.
  const gemini = usageFromGemini({ promptTokenCount: 100, candidatesTokenCount: 200, thoughtsTokenCount: 700, totalTokenCount: 1_000 });
  assert.equal(gemini.completionTokens, 900);
  assert.equal(gemini.reasoningTokens, 700);
  assert.equal(billableTokens(gemini), 1_000);
});

test("Anthropic-style usage (cache fields reported separately, merged into prompt) bills the same way", () => {
  // AnthropicUsageTracker turns input 50 + cache_read 8,000 + cache_creation 1,000 into prompt 9,050.
  const usage = u(9_050, 300, { cachedTokens: 8_000, cacheWriteTokens: 1_000 });
  assert.equal(billableTokens(usage), 50 + 1_000 + 300 + 800);
});

test("malformed or missing usage fields can't produce negative, NaN or inflated counts", () => {
  const usage = usageFromOpenAi({ prompt_tokens: "abc", completion_tokens: -5, prompt_tokens_details: { cached_tokens: 99 } } as never);
  assert.deepEqual([usage.promptTokens, usage.completionTokens, usage.cachedTokens ?? 0], [0, 0, 0]);
  assert.equal(billableTokens(usage), 0);
  // cached > prompt is clamped to the prompt; reasoning > completion clamped to completion.
  const odd = normalizeUsage(u(100, 10, { cachedTokens: 500, reasoningTokens: 50 }));
  assert.equal(odd.cachedTokens, 100);
  assert.equal(odd.reasoningTokens, 10);
  assert.equal(billableTokens(odd), 10 + Math.ceil(100 * CACHE_READ_WEIGHT));
  // String numbers from a JSON body are accepted.
  assert.equal(billableTokens(usageFromOpenAi({ prompt_tokens: "40", completion_tokens: "2" } as never)), 42);
});

test("a running total turns into per-round deltas that add back up exactly", () => {
  const rounds = [u(1_000, 100), u(2_500, 300, { cachedTokens: 900 }), u(4_100, 420, { cachedTokens: 2_300 })];
  let recorded = u(0, 0);
  let sum = 0;
  for (const cumulative of rounds) {
    const delta = usageDelta(cumulative, recorded);
    sum += billableTokens(delta);
    recorded = cumulative;
  }
  // Same as metering each round's own usage: 1,100 + (1,500-900+90+200) + (1,600-1,400+140+120).
  assert.equal(sum, 1_100 + 890 + 460);
  // Re-reporting the same total adds nothing.
  assert.equal(billableTokens(usageDelta(rounds[2]!, rounds[2]!)), 0);
});

test("plan allowances: ₹999 = 10M, ₹1,999 = 25M, Free = 1M, Enterprise 30M per seat", () => {
  assert.equal(PLAN_ALLOWANCES.pro, 10_000_000);
  assert.equal(PLAN_ALLOWANCES.premium, 25_000_000);
  assert.equal(PLAN_ALLOWANCES.free, 1_000_000);
  assert.equal(ENTERPRISE_TOKENS_PER_SEAT, 30_000_000);
});

test("balance rule: remaining = allowance − used − adjustments − reserved", () => {
  assert.equal(remainingOf({ allowance: 10_000_000, used: 2_450_000, adjustments: 0, reserved: 50_000 }), 7_500_000);
  // A bonus is a negative adjustment: it gives tokens back.
  assert.equal(remainingOf({ allowance: 1_000, used: 1_000, adjustments: -300, reserved: 0 }), 300);
  assert.equal(percentUsed({ allowance: 10_000_000, used: 2_450_000, adjustments: 0 }), 24);
  assert.equal(percentUsed({ allowance: 1_000, used: 1_200, adjustments: 0 }), 100); // an overrun reads as 100 %, not 120 %
  assert.equal(percentUsed({ allowance: 1_000, used: 100, adjustments: -500 }), 0);
});

test("snapshots from SQL JSON are validated (bigint strings, bad values)", () => {
  const s = snapshotFromRow({ account_id: "a", plan: "pro", allowance: "10000000", used: 5, adjustments: null, reserved: "x", remaining: 9_999_995, period_start: "2026-10-17T00:00:00Z", period_end: "2026-11-17T00:00:00Z", status: "active" });
  assert.equal(s.allowance, 10_000_000);
  assert.equal(s.adjustments, 0);
  assert.equal(s.reserved, 0);
  assert.equal(s.periodEnd, "2026-11-17T00:00:00.000Z");
});

test("monthly periods follow the subscription date, clamped at month end and back again", () => {
  const anchor = new Date("2026-01-31T10:30:00Z");
  assert.equal(addMonthsUtc(anchor, 1).toISOString(), "2026-02-28T10:30:00.000Z");
  assert.equal(addMonthsUtc(anchor, 2).toISOString(), "2026-03-31T10:30:00.000Z"); // from the anchor, not from Feb 28
  assert.equal(addMonthsUtc(anchor, 3).toISOString(), "2026-04-30T10:30:00.000Z");
  assert.equal(addMonthsUtc(anchor, 11).toISOString(), "2026-12-31T10:30:00.000Z");
  assert.equal(addMonthsUtc(anchor, 13).toISOString(), "2027-02-28T10:30:00.000Z");
  // Leap years.
  assert.equal(addMonthsUtc(new Date("2028-01-31T00:00:00Z"), 1).toISOString(), "2028-02-29T00:00:00.000Z");
  assert.equal(addMonthsUtc(new Date("2028-02-29T00:00:00Z"), 12).toISOString(), "2029-02-28T00:00:00.000Z");
  assert.equal(addMonthsUtc(new Date("2028-02-29T00:00:00Z"), 48).toISOString(), "2032-02-29T00:00:00.000Z");
  // The 17th to the 17th.
  const p = periodFor(new Date("2026-03-17T06:00:00Z"), new Date("2026-10-20T00:00:00Z"));
  assert.equal(p.index, 7);
  assert.equal(p.start.toISOString(), "2026-10-17T06:00:00.000Z");
  assert.equal(p.end.toISOString(), "2026-11-17T06:00:00.000Z");
});

test("period boundaries are exact: the renewal instant belongs to the NEW period", () => {
  const anchor = new Date("2026-10-17T06:00:00Z");
  assert.equal(periodFor(anchor, new Date("2026-11-17T05:59:59.999Z")).index, 0);
  assert.equal(periodFor(anchor, new Date("2026-11-17T06:00:00.000Z")).index, 1);
  assert.equal(periodFor(anchor, new Date("2026-10-16T00:00:00Z")).index, 0); // before the anchor
});
