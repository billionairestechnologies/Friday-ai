import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveMetrics, type Metric } from "../src/services/finance/summary.js";

const base = {
  days: 30,
  rev: { cash_in: 1_000_000, refunds: 50_000, chargebacks: 0, fees: 20_000, fees_unknown: 0, payments: 20, payers: 20, recognised: 800_000, deferred_at_end: 300_000 },
  aiCostInr: 2_000,
  sandboxCostInr: 500,
  otherExpensesInr: 6_000,
  unpricedModels: 0,
  outstandingCreditTokens: 40_000_000,
  creditTokensUsed: 4_000_000,
  blendedCostPerMInr: 25,
};
const get = (ms: Metric[], k: string) => ms.find((m) => m.key === k)!;

test("cash and revenue stay separate; profit follows from earned revenue", () => {
  const m = deriveMetrics(base);
  assert.equal(get(m, "cash").value, 10_000);
  assert.equal(get(m, "netCash").value, 9_500);
  assert.equal(get(m, "recognised").value, 8_000);
  assert.equal(get(m, "deferred").value, 3_000);
  // Gross = 8000 − (2000 + 500 + 200 fees) = 5300; margin 66.25 %.
  assert.equal(get(m, "gross").value, 5_300);
  assert.equal(get(m, "grossMargin").value, 66.25);
  assert.equal(get(m, "operating").value, -700);
  assert.equal(get(m, "cash").basis, "actual");
  assert.equal(get(m, "opex").basis, "entered");
});

test("burn, break-even and ARPPU are labelled estimates with their formula", () => {
  const m = deriveMetrics(base);
  // Net flow = 9500 − (2700 + 6000) = 800 → cash positive, no burn.
  assert.equal(get(m, "netFlow").value, 800);
  assert.equal(get(m, "burn").value, 0);
  assert.equal(get(m, "arppu").value, 400);
  // Break-even: 6000 ÷ 0.6625 = 9056.60; ÷ 400 per customer = 23 customers.
  assert.equal(get(m, "breakEvenRevenue").value, 9056.6);
  assert.equal(get(m, "breakEvenCustomers").value, 23);
  for (const k of ["burn", "breakEvenRevenue", "breakEvenCustomers", "creditExposure"]) {
    assert.equal(get(m, k).basis, "estimate", k);
    assert.ok(get(m, k).formula.length > 20, `${k} explains itself`);
  }
  const burning = deriveMetrics({ ...base, days: 15, otherExpensesInr: 20_000 });
  // Net flow = 9500 − 2700 − 20000 = −13200 over 15 days → 26,400 a month.
  assert.equal(get(burning, "burn").value, 26_400);
});

test("credits are cost exposure, never revenue; no margin → no break-even", () => {
  const m = deriveMetrics(base);
  assert.equal(get(m, "creditExposure").value, 1_000);
  assert.equal(get(m, "creditUsed").value, 100);
  const none = deriveMetrics({ ...base, rev: { ...base.rev, recognised: 0, payers: 0 } });
  assert.equal(get(none, "grossMargin").value, null);
  assert.equal(get(none, "breakEvenRevenue").value, null);
  assert.equal(get(none, "arppu").value, null);
});

test("unpriced models turn cost-based figures into estimates and say why", () => {
  const m = deriveMetrics({ ...base, unpricedModels: 2, rev: { ...base.rev, fees_unknown: 3 } });
  assert.equal(get(m, "aiCost").basis, "estimate");
  assert.equal(get(m, "gross").basis, "estimate");
  assert.match(get(m, "aiCost").note ?? "", /2 model/);
  assert.match(get(m, "fees").note ?? "", /3 payment/);
});
