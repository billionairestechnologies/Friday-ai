import assert from "node:assert/strict";
import test from "node:test";
import { occurrencesInWindow } from "../src/services/finance/expenses.js";
import { findPricing, matchOpenRouter, normalizeModelId, perMillion, priceTokens, sellRatesInr, type ModelPricing } from "../src/services/finance/pricing.js";
import { modelLines } from "../src/services/finance/report.js";

const s = { usd_to_inr: 88, default_markup_pct: 40, blended_cost_per_m_inr: 0, target_cost_share_pct: 40, free_cost_budget_inr: 25, e2b_cost_per_hour_inr: 4.4 };

function row(over: Partial<ModelPricing>): ModelPricing {
  return {
    id: "x", provider_slug: "anthropic", model_id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", cost_currency: "USD",
    cost_input_per_m: 3, cost_output_per_m: 15, cost_cache_read_per_m: null, cost_cache_write_per_m: null, cost_per_image: null,
    cost_source: "", sell_input_per_m_inr: null, sell_output_per_m_inr: null, sell_per_image_inr: null, is_public: false, notes: "",
    updated_at: "", ...over,
  };
}

test("model ids from different sources normalize to one key", () => {
  assert.equal(normalizeModelId("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(normalizeModelId("anthropic/claude-sonnet-4.5"), "claude-sonnet-4-5");
  assert.equal(normalizeModelId("anthropic/claude-sonnet-4.5:thinking"), "claude-sonnet-4-5");
  assert.equal(normalizeModelId("gemini-2.5-pro"), normalizeModelId("google/gemini-2.5-pro"));
  const rows = [row({ model_id: "claude-sonnet-4-5" })];
  assert.ok(findPricing(rows, "anthropic", "claude-sonnet-4-5-20250929"));
  assert.equal(findPricing(rows, "openai", "claude-sonnet-4-5"), null, "a different provider is a different price");
});

test("1M input + 1M output on Sonnet: $3 + $15 cost; sell at cost × FX × 1.4 by default", () => {
  const p = priceTokens(row({}), { input: 1_000_000, output: 1_000_000, cached: 0, cacheWrite: 0 }, s);
  assert.equal(p.costUsd, 18);
  // (3 + 15) × 88 × 1.4 = 2217.6 INR
  assert.equal(p.sellInr, 2217.6);
});

test("cache reads/writes are priced at their own rate (provider default ratio when not set)", () => {
  // 1M prompt tokens: 600k cached (0.1×), 100k cache write (1.25×), 300k plain.
  const p = priceTokens(row({}), { input: 1_000_000, output: 0, cached: 600_000, cacheWrite: 100_000 }, s);
  const expected = (300_000 * 3 + 600_000 * 0.3 + 100_000 * 3.75) / 1_000_000;
  assert.equal(p.costUsd, Math.round(expected * 1e8) / 1e8);
  // Explicit cache prices win over the default ratio.
  const q = priceTokens(row({ cost_cache_read_per_m: 0.5 }), { input: 1_000_000, output: 0, cached: 1_000_000, cacheWrite: 0 }, s);
  assert.equal(q.costUsd, 0.5);
});

test("explicit sell prices and INR cost (reseller billing in rupees)", () => {
  const r = row({ sell_input_per_m_inr: 400, sell_output_per_m_inr: 1800 });
  assert.deepEqual(priceTokens(r, { input: 500_000, output: 100_000, cached: 0, cacheWrite: 0 }, s).sellInr, 200 + 180);
  const inr = row({ cost_currency: "INR", cost_input_per_m: 264, cost_output_per_m: 1320 });
  assert.equal(priceTokens(inr, { input: 1_000_000, output: 0, cached: 0, cacheWrite: 0 }, s).costUsd, 3);
  const sell = sellRatesInr(row({}), s);
  assert.equal(sell.input, 369.6);
  assert.ok(sell.inputIsDefault);
});

test("OpenRouter list prices: per-token USD → per 1M, matched to our ids", () => {
  assert.equal(perMillion("0.000003"), 3);
  assert.equal(perMillion("-1"), null);
  assert.equal(perMillion(undefined), null);
  const models = [
    { id: "anthropic/claude-sonnet-4.5", pricing: { prompt: "0.000003", completion: "0.000015" } },
    { id: "anthropic/claude-sonnet-4.5:free", pricing: { prompt: "0", completion: "0" } },
    { id: "google/gemini-2.5-pro", pricing: { prompt: "0.00000125", completion: "0.00001" } },
  ];
  assert.equal(matchOpenRouter(models, "anthropic", "claude-sonnet-4-5-20250929")?.id, "anthropic/claude-sonnet-4.5");
  assert.equal(matchOpenRouter(models, "gemini", "gemini-2.5-pro")?.id, "google/gemini-2.5-pro");
  assert.equal(matchOpenRouter(models, "openrouter", "google/gemini-2.5-pro")?.id, "google/gemini-2.5-pro");
  assert.equal(matchOpenRouter(models, "openai", "gpt-unknown"), null);
});

test("report lines: stored exact cost + unpriced calls at today's price, margin % of selling price", () => {
  const lines = modelLines(
    [
      {
        provider_slug: "anthropic", model_id: "claude-sonnet-4-5", calls: 3, input_tokens: 2_000_000, output_tokens: 200_000, cached_tokens: 0, cache_write_tokens: 0,
        priced_calls: 2, priced_cost_usd: 6, priced_sell_inr: 739.2,
        unpriced_input_tokens: 1_000_000, unpriced_output_tokens: 0, unpriced_cached_tokens: 0, unpriced_cache_write_tokens: 0,
      },
      {
        provider_slug: "mystery", model_id: "m1", calls: 1, input_tokens: 1000, output_tokens: 1000, cached_tokens: 0, cache_write_tokens: 0,
        priced_calls: 0, priced_cost_usd: 0, priced_sell_inr: 0,
        unpriced_input_tokens: 1000, unpriced_output_tokens: 1000, unpriced_cached_tokens: 0, unpriced_cache_write_tokens: 0,
      },
    ],
    [row({})],
    s,
    () => 0.01,
  );
  const sonnet = lines.find((l) => l.model === "claude-sonnet-4-5")!;
  // cost: $6 stored + $3 (1M unpriced input) = $9 → ₹792; value: 739.2 + 369.6 = 1108.8
  assert.equal(sonnet.costInr, 792);
  assert.equal(sonnet.valueInr, 1108.8);
  assert.equal(sonnet.marginInr, 316.8);
  assert.equal(sonnet.marginPct, 28.57);
  assert.equal(sonnet.pricing, "current");
  const mystery = lines.find((l) => l.model === "m1")!;
  assert.equal(mystery.pricing, "estimated");
  assert.equal(mystery.marginPct, null);
});

test("recurring expenses are counted once per occurrence inside the window", () => {
  assert.equal(occurrencesInWindow({ incurred_on: "2026-09-15", recurrence: "none" }, "2026-09-01", "2026-09-30"), 1);
  assert.equal(occurrencesInWindow({ incurred_on: "2026-08-15", recurrence: "none" }, "2026-09-01", "2026-09-30"), 0);
  assert.equal(occurrencesInWindow({ incurred_on: "2026-01-10", recurrence: "monthly" }, "2026-01-01", "2026-06-30"), 6);
  assert.equal(occurrencesInWindow({ incurred_on: "2026-01-31", recurrence: "monthly" }, "2026-02-01", "2026-02-28"), 1, "31st lands on Feb 28");
  assert.equal(occurrencesInWindow({ incurred_on: "2025-03-01", recurrence: "yearly" }, "2026-01-01", "2026-12-31"), 1);
  assert.equal(occurrencesInWindow({ incurred_on: "2027-01-01", recurrence: "monthly" }, "2026-01-01", "2026-12-31"), 0);
});
