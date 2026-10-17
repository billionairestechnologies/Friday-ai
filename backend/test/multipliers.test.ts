import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  applyMultiplier,
  multiplierFor,
  previewImpact,
  resolveMultiplier,
  setMultiplierLoaderForTests,
  validatePublish,
  type MultiplierRow,
  type PublishItem,
} from "../src/services/quota/multipliers.js";
import { setQuotaRpcForTests, type Reservation } from "../src/services/quota/tokenQuotaService.js";
import { setUsagePricerForTests, UsageMeter } from "../src/services/quota/usageMeter.js";
import { billableTokens } from "../src/services/quota/allowance.js";

const H = 3_600_000;
const NOW = Date.parse("2026-10-17T12:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
let seq = 0;
function row(over: Partial<MultiplierRow>): MultiplierRow {
  seq++;
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    provider_slug: "anthropic",
    model_id: "claude-opus-5",
    multiplier: 1,
    kind: "base",
    effective_from: at(-48 * H),
    effective_to: null,
    reason: "test",
    created_by: null,
    created_at: at(-48 * H + seq),
    cancelled_at: null,
    cancelled_by: null,
    ...over,
  };
}

after(() => {
  setMultiplierLoaderForTests(null);
  setQuotaRpcForTests(null);
  setUsagePricerForTests(null);
});

test("a model with no configuration is charged at 1×", () => {
  assert.deepEqual(resolveMultiplier([], "openai", "gpt-5.6", NOW), { multiplier: 1, id: null });
});

test("the newest base row in effect applies; a scheduled one only from its start time", () => {
  const old = row({ multiplier: 2 });
  const current = row({ multiplier: 4, effective_from: at(-1 * H), created_at: at(-1 * H) });
  const scheduled = row({ multiplier: 10, effective_from: at(5 * H), created_at: at(-30 * 60_000) });
  const rows = [old, current, scheduled];
  assert.equal(resolveMultiplier(rows, "anthropic", "claude-opus-5", NOW).multiplier, 4);
  assert.equal(resolveMultiplier(rows, "anthropic", "claude-opus-5", NOW + 5 * H).multiplier, 10);
  assert.equal(resolveMultiplier(rows, "anthropic", "claude-opus-5", NOW - 2 * H).multiplier, 2, "history is answered by time, not by latest row");
});

test("a promotion beats the base value only inside its window, and a cancelled row never applies", () => {
  const base = row({ multiplier: 4 });
  const promo = row({ kind: "promo", multiplier: 0.5, effective_from: at(-1 * H), effective_to: at(2 * H) });
  assert.equal(resolveMultiplier([base, promo], "anthropic", "claude-opus-5", NOW).multiplier, 0.5);
  assert.equal(resolveMultiplier([base, promo], "anthropic", "claude-opus-5", NOW + 2 * H).multiplier, 4, "end is exclusive");
  const ended = { ...promo, cancelled_at: at(0) };
  assert.equal(resolveMultiplier([base, ended], "anthropic", "claude-opus-5", NOW).multiplier, 4);
});

test("exact provider beats '*', and a '*' promo beats an exact base", () => {
  const exactBase = row({ multiplier: 3 });
  const anyBase = row({ provider_slug: "*", multiplier: 2 });
  assert.equal(resolveMultiplier([exactBase, anyBase], "anthropic", "claude-opus-5", NOW).multiplier, 3);
  assert.equal(resolveMultiplier([exactBase, anyBase], "scalemax", "claude-opus-5", NOW).multiplier, 2, "another provider of the same model gets the '*' row");
  const anyPromo = row({ provider_slug: "*", kind: "promo", multiplier: 0, effective_from: at(-H), effective_to: at(H) });
  assert.equal(resolveMultiplier([exactBase, anyBase, anyPromo], "anthropic", "claude-opus-5", NOW).multiplier, 0);
  assert.equal(resolveMultiplier([exactBase], "anthropic", "claude-sonnet-5", NOW).multiplier, 1, "other models untouched");
});

test("applyMultiplier rounds up, is exact at 1×, and never goes negative", () => {
  assert.equal(applyMultiplier(1_000, 1), 1_000);
  assert.equal(applyMultiplier(1_000, 2.5), 2_500);
  assert.equal(applyMultiplier(3, 0.5), 2);
  assert.equal(applyMultiplier(30, 0.1), 3, "no float drift: 30 × 0.1 is 3, not 4");
  assert.equal(applyMultiplier(1_000, 0), 0);
  assert.equal(applyMultiplier(0, 10), 0);
});

test("publishing is validated: range, decimals, no backdating, promos need an end, reasons required", () => {
  const ok: PublishItem = { provider_slug: "anthropic", model_id: "claude-opus-5", multiplier: 2, kind: "base", reason: "Opus costs 5x Sonnet", expected_latest: null };
  assert.doesNotThrow(() => validatePublish([ok], NOW));
  const bad: Array<[Partial<PublishItem>, RegExp]> = [
    [{ multiplier: -1 }, /between 0 and/],
    [{ multiplier: 101 }, /between 0 and/],
    [{ multiplier: 1.23456 }, /4 decimal/],
    [{ effective_from: at(-10 * 60_000) }, /backdated/],
    [{ kind: "promo" }, /end time/],
    [{ kind: "promo", effective_to: at(-H) }, /end after/],
    [{ effective_to: at(H) }, /no end time/],
    [{ reason: " " }, /why/],
  ];
  for (const [patch, msg] of bad) assert.throws(() => validatePublish([{ ...ok, ...patch }], NOW), msg, JSON.stringify(patch));
  assert.throws(() => validatePublish([ok, ok], NOW), /twice/);
  assert.throws(() => validatePublish([], NOW), /at least one/);
});

test("the preview projects past usage at the proposed multiplier", () => {
  const p = previewImpact({ provider_slug: "anthropic", model_id: "claude-opus-5", calls: 10, users: 3, base_billable: 1_000, billable: 2_000, cost_usd: 1.5 }, 4);
  assert.deepEqual(p, { calls: 10, users: 3, baseBillable: 1_000, chargedBillable: 2_000, projectedBillable: 4_000, providerCostUsd: 1.5 });
  assert.equal(previewImpact(null, 4).projectedBillable, 0);
});

test("config that can't be read falls back to the last loaded value, else 1×", async () => {
  let fail = false;
  setMultiplierLoaderForTests(async () => {
    if (fail) throw new Error("db down");
    return [row({ model_id: "m-fallback", multiplier: 3, effective_from: new Date(Date.now() - H).toISOString() })];
  });
  assert.equal((await multiplierFor("anthropic", "m-fallback")).multiplier, 3);
  fail = true;
  setMultiplierLoaderForTests(async () => {
    throw new Error("db down");
  });
  assert.equal((await multiplierFor("anthropic", "m-fallback")).multiplier, 1, "nothing cached at all → 1×");
});

test("the meter charges ⌈base × multiplier⌉, stores both, keeps cost on a 0× model, and ignores multipliers for free rows", async () => {
  const live = Date.now();
  setMultiplierLoaderForTests(async () => [
    row({ model_id: "claude-opus-5", multiplier: 4, effective_from: new Date(live - H).toISOString(), id: "11111111-1111-1111-1111-111111111111" }),
    row({ provider_slug: "*", model_id: "free-model", multiplier: 0, effective_from: new Date(live - H).toISOString() }),
  ]);
  setUsagePricerForTests(async () => ({ costUsd: 0.25, sellInr: null, priced: true }));
  const events: Record<string, unknown>[] = [];
  setQuotaRpcForTests(async <T>(fn: string, args: Record<string, unknown>) => {
    if (fn === "quota_record_usage") events.push(args.p_event as Record<string, unknown>);
    return {
      ok: true, crossed: 0, account_id: "a", plan: "pro", allowance: 1e9, used: 0, adjustments: 0, reserved: 0, remaining: 1e9,
      period_start: "2026-10-17T00:00:00Z", period_end: "2026-11-17T00:00:00Z", status: "active",
    } as T;
  });
  const reservation = { id: "r1", accountId: "a", hold: 100 } as unknown as Reservation;
  const meter = new UsageMeter(reservation, { userId: "u", feature: "chat" });
  const usage = { promptTokens: 1_000, completionTokens: 200, totalTokens: 1_200, cachedTokens: 600 };
  const base = billableTokens(usage);

  await meter.recordCall({ slug: "anthropic", modelId: "claude-opus-5" }, usage);
  await meter.recordCall({ slug: "scalemax", modelId: "free-model" }, usage);
  await meter.recordCall({ slug: "anthropic", modelId: "claude-opus-5" }, usage, { chargeable: false });

  assert.equal(events[0]!.base_billable_tokens, base);
  assert.equal(events[0]!.billable_tokens, base * 4);
  assert.equal(events[0]!.usage_multiplier, 4);
  assert.equal(events[0]!.multiplier_id, "11111111-1111-1111-1111-111111111111");
  assert.equal(events[0]!.meter_version, "billable-v2");
  assert.equal(events[1]!.billable_tokens, 0, "0× = free for the customer");
  assert.equal(events[1]!.cost_usd, 0.25, "…but our provider cost is still recorded");
  assert.equal(events[2]!.billable_tokens, 0, "non-chargeable rows stay free");
  assert.equal(events[2]!.usage_multiplier, 1);
  assert.equal(meter.billable, base * 4);
});
