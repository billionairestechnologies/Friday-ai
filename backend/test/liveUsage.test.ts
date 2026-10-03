import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateLive, flagSpike, type LedgerRow } from "../src/services/finance/liveUsage.js";

const now = Date.parse("2026-10-03T12:00:00Z");
const row = (user: string, minsAgo: number, usd: number, feature: string | null = "chat", model = "m1"): LedgerRow => ({
  user_id: user, provider_slug: "anthropic", model_id: model, feature, cost_usd: usd, created_at: new Date(now - minsAgo * 60_000).toISOString(),
});

test("aggregates cost by hour, feature, model and user, against the previous window", () => {
  const rows = [row("a", 30, 1), row("a", 90, 1, "build"), row("b", 600, 0.5, null, "m2"), row("a", 24 * 60 + 30, 2)];
  const r = aggregateLive(rows, 100, now, 24);
  assert.equal(r.totalCostInr, 250); // (1 + 1 + 0.5) × 100
  assert.equal(r.previousCostInr, 200);
  assert.equal(r.hourly.length, 24);
  assert.equal(r.hourly[23]!.costInr, 100); // the last hour holds the 30-minutes-ago call
  assert.deepEqual(r.byFeature.map((f) => f.feature).sort(), ["build", "chat"]);
  assert.equal(r.topUsers[0]!.userId, "a");
  assert.equal(r.topUsers[0]!.calls, 2);
});

test("a day of usage worth a quarter of the monthly allowance is a spike", () => {
  assert.equal(flagSpike(100, 400), true);
  assert.equal(flagSpike(99, 400), false);
  assert.equal(flagSpike(10, 0), false);
});
