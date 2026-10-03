import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlanEconomics } from "../src/services/finance/planEconomics.js";
import { effectiveCostRatesUsd, type FinanceSettings, type ModelPricing } from "../src/services/finance/pricing.js";

const s: FinanceSettings = { usd_to_inr: 88, default_markup_pct: 40, blended_cost_per_m_inr: 25, target_cost_share_pct: 40, free_cost_budget_inr: 25, e2b_cost_per_hour_inr: 4.4 };
const pro = { id: "pro" as const, name: "Pro", monthlyPricePaise: 99_900, limits: { weekly: 110_000, rolling: 60_000, monthly: 450_000, tokensPerSeat: null } };

test("Pro at its monthly cap: usage ≈ ₹396 on ₹999, ~16M tokens at ₹25/M", () => {
  const e = computePlanEconomics({ plan: pro, e2bAvgInr: 20, subscribers: 10 }, s, 50);
  assert.equal(e.usageCostInr, 396);
  assert.equal(e.tokensMillions, 15.84);
  assert.equal(e.totalCostInr, 396 + 20 + 50);
  assert.equal(e.marginInr, 999 - 466);
  assert.equal(e.status, "ok");
});

test("a supplier price rise flips a plan to loss, and the suggestion shrinks the caps back to the target share", () => {
  const dear = { ...s, blended_cost_per_m_inr: 80, usd_to_inr: 88 };
  // Same credits: credits are priced at the model rates, so the plan itself doesn't change cost — the
  // credit value does. Raise the FX instead to model a cost increase on the same cap.
  const costly = { ...dear, usd_to_inr: 200 };
  const e = computePlanEconomics({ plan: pro, e2bAvgInr: 0, subscribers: 1 }, costly, 0);
  assert.ok(e.usageCostInr > 999 * 0.4);
  const budgetCredits = Math.floor((999 * 0.4 / 200) * 100_000);
  assert.equal(e.suggested.monthly, budgetCredits);
  assert.ok(e.suggested.rolling < pro.limits.rolling && e.suggested.weekly < pro.limits.weekly);
});

test("Free is judged against its monthly cost budget, enterprise per seat", () => {
  const free = { id: "free" as const, name: "Free", monthlyPricePaise: 0, limits: { weekly: 6_500, rolling: 2_500, monthly: null, tokensPerSeat: null } };
  const f = computePlanEconomics({ plan: free, e2bAvgInr: 0, subscribers: 100 }, s, 80);
  assert.equal(f.overheadInr, 0);
  assert.equal(f.status, "ok");
  const ent = { id: "enterprise" as const, name: "Enterprise", monthlyPricePaise: 249_900, limits: { weekly: 0, rolling: 0, monthly: null, tokensPerSeat: 1_000_000 } };
  const e = computePlanEconomics({ plan: ent, e2bAvgInr: 0, subscribers: 3 }, s, 0);
  assert.equal(e.monthlyCredits, 1_000_000);
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
