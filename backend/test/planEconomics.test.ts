import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlanEconomics } from "../src/services/finance/planEconomics.js";
import { effectiveCostRatesUsd, type FinanceSettings, type ModelPricing } from "../src/services/finance/pricing.js";

const s: FinanceSettings = { usd_to_inr: 88, default_markup_pct: 40, blended_cost_per_m_inr: 25, target_cost_share_pct: 40, free_cost_budget_inr: 25, e2b_cost_per_hour_inr: 4.4 };
const pro = { id: "pro" as const, name: "Pro", monthlyPricePaise: 99_900, limits: { monthly: 10_000_000, tokensPerSeat: null } };

test("Pro at its full monthly allowance: 10M tokens ≈ ₹250 on ₹999 at ₹25/M", () => {
  const e = computePlanEconomics({ plan: pro, e2bAvgInr: 20, subscribers: 10 }, s, 50);
  assert.equal(e.monthlyTokens, 10_000_000);
  assert.equal(e.usageCostInr, 250);
  assert.equal(e.tokensMillions, 10);
  assert.equal(e.totalCostInr, 250 + 20 + 50);
  assert.equal(e.marginInr, 999 - 320);
  assert.equal(e.status, "ok");
});

test("a supplier price rise squeezes the margin, and the suggestion shrinks the allowance back to the target share", () => {
  const dear = { ...s, blended_cost_per_m_inr: 80 };
  const e = computePlanEconomics({ plan: pro, e2bAvgInr: 0, subscribers: 1 }, dear, 0);
  assert.equal(e.usageCostInr, 800);
  assert.equal(e.status, "tight");
  // ₹999 × 40 % = ₹399.6 of usage at ₹80/M ≈ 4.995M → rounded down to a whole 100K.
  assert.equal(e.suggested.monthly, 4_900_000);
  assert.equal(computePlanEconomics({ plan: pro, e2bAvgInr: 0, subscribers: 1 }, { ...s, blended_cost_per_m_inr: 120 }, 0).status, "loss");
});

test("Free is judged against its monthly cost budget, enterprise per seat", () => {
  const free = { id: "free" as const, name: "Free", monthlyPricePaise: 0, limits: { monthly: 1_000_000, tokensPerSeat: null } };
  const f = computePlanEconomics({ plan: free, e2bAvgInr: 0, subscribers: 100 }, s, 80);
  assert.equal(f.overheadInr, 0);
  assert.equal(f.usageCostInr, 25);
  assert.equal(f.status, "ok");
  const ent = { id: "enterprise" as const, name: "Enterprise", monthlyPricePaise: 249_900, limits: { monthly: null, tokensPerSeat: 30_000_000 } };
  const e = computePlanEconomics({ plan: ent, e2bAvgInr: 0, subscribers: 3 }, s, 0);
  assert.equal(e.monthlyTokens, 30_000_000);
  assert.ok(e.suggested.tokensPerSeat && e.suggested.tokensPerSeat > 0);
});

const modelRow = (over: Partial<ModelPricing>): ModelPricing => ({
  id: "x", provider_slug: "anthropic", model_id: "m", display_name: null, cost_currency: "USD", cost_input_per_m: 3, cost_output_per_m: 15,
  cost_cache_read_per_m: null, cost_cache_write_per_m: null, cost_per_image: null, cost_source: "", sell_input_per_m_inr: null,
  sell_output_per_m_inr: null, sell_per_image_inr: null, is_public: false, notes: "", updated_at: "", ...over,
});

test("blended rate applies to every model, a per-model override keeps its own price, blended 0 = list prices", () => {
  const flat = effectiveCostRatesUsd(modelRow({}), s)!;
  assert.equal(flat.source, "blended");
  assert.ok(Math.abs(flat.rates.input - 25 / 88) < 1e-9 && flat.rates.cacheRead === flat.rates.input);
  assert.equal(effectiveCostRatesUsd(null, s)!.source, "blended");
  const own = effectiveCostRatesUsd(modelRow({ cost_override: true }), s)!;
  assert.equal(own.source, "model");
  assert.equal(own.rates.input, 3);
  assert.equal(effectiveCostRatesUsd(modelRow({}), { ...s, blended_cost_per_m_inr: 0 })!.source, "model");
  assert.equal(effectiveCostRatesUsd(null, { ...s, blended_cost_per_m_inr: 0 }), null);
});
