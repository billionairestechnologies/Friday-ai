import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  checkAndReserve,
  QuotaUnavailableError,
  setPlanLookupForTests,
  setQuotaRpcForTests,
  type Reservation,
} from "../src/services/quota/tokenQuotaService.js";
import { setUsagePricerForTests, UsageMeter } from "../src/services/quota/usageMeter.js";
import { setMultiplierLoaderForTests } from "../src/services/quota/multipliers.js";
import { meteredChat, withMeter } from "../src/services/quota/meterContext.js";
import { billableTokens } from "../src/services/quota/allowance.js";

/**
 * An in-memory stand-in for the 0057 SQL functions with the same contract (hold, idempotent
 * ledger, settle), plus failure injection. The real SQL — locking, periods, lifecycle — is tested
 * against Postgres in quotaLedger.db.test.ts.
 */
class FakeLedger {
  allowance = 10_000;
  used = 0;
  reserved = 0;
  rows = new Map<string, Record<string, unknown>>();
  holds = new Map<string, { hold: number; status: string }>();
  /** Fail the next N calls of this function before (or, with `afterCommit`, after) doing the work. */
  failures: Array<{ fn: string; afterCommit?: boolean }> = [];
  calls: string[] = [];

  snapshot(extra: Record<string, unknown> = {}) {
    return {
      account_id: "acc-1",
      plan: "pro",
      allowance: this.allowance,
      used: this.used,
      adjustments: 0,
      reserved: this.reserved,
      remaining: this.allowance - this.used - this.reserved,
      period_start: "2026-10-17T00:00:00Z",
      period_end: "2026-11-17T00:00:00Z",
      status: "active",
      ...extra,
    };
  }

  rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    this.calls.push(fn);
    const failure = this.failures.findIndex((f) => f.fn === fn);
    const fail = failure >= 0 ? this.failures.splice(failure, 1)[0]! : null;
    if (fail && !fail.afterCommit) throw new QuotaUnavailableError("connection reset");
    const out = this.run(fn, args);
    if (fail?.afterCommit) throw new QuotaUnavailableError("response lost after commit");
    return out as T;
  };

  private run(fn: string, a: Record<string, unknown>): unknown {
    if (fn === "quota_reserve") {
      const amount = Number(a.p_amount);
      if (amount > this.allowance - this.used - this.reserved) return this.snapshot({ ok: false, reason: "exhausted" });
      this.holds.set(String(a.p_reservation), { hold: amount, status: "active" });
      this.reserved += amount;
      return this.snapshot({ ok: true });
    }
    if (fn === "quota_extend_hold") {
      const r = this.holds.get(String(a.p_reservation))!;
      const delta = Number(a.p_hold) - r.hold;
      if (delta > 0 && delta > this.allowance - this.used - this.reserved) return this.snapshot({ ok: false, reason: "exhausted" });
      if (delta > 0) {
        r.hold += delta;
        this.reserved += delta;
      }
      return this.snapshot({ ok: true });
    }
    if (fn === "quota_record_usage") {
      const event = a.p_event as Record<string, unknown>;
      const key = String(event.idempotency_key);
      if (this.rows.has(key)) return this.snapshot({ ok: this.allowance - this.used - this.reserved > 0, duplicate: true });
      this.rows.set(key, event);
      const billable = Number(event.billable_tokens);
      const r = this.holds.get(String(a.p_reservation))!;
      const release = r.status === "active" ? Math.min(r.hold, billable) : 0;
      r.hold -= release;
      this.reserved -= release;
      this.used += billable;
      return this.snapshot({ ok: this.allowance - this.used - this.reserved > 0, crossed: 0 });
    }
    if (fn === "quota_settle") {
      const r = this.holds.get(String(a.p_reservation));
      if (!r || r.status !== "active") return this.snapshot({ settled: false });
      this.reserved -= r.hold;
      r.hold = 0;
      r.status = String(a.p_status);
      return this.snapshot({ settled: true });
    }
    throw new Error(`unexpected rpc ${fn}`);
  }
}

let ledger: FakeLedger;
const userId = "00000000-0000-0000-0000-0000000000aa";
const pro = { slug: "openai", modelId: "gpt-5.6" };
const claude = { slug: "anthropic", modelId: "claude-sonnet-5" };

beforeEach(() => {
  ledger = new FakeLedger();
  setQuotaRpcForTests(ledger.rpc);
  setPlanLookupForTests(async () => ({ plan: "pro", planRenewsAt: null, customMonthlyCap: null, enterprise: null }));
  setUsagePricerForTests(async () => ({ costUsd: 0.001, sellInr: null, priced: true }));
  setMultiplierLoaderForTests(async () => []);
});
after(() => {
  setUsagePricerForTests(null);
  setMultiplierLoaderForTests(null);
  setQuotaRpcForTests(null);
  setPlanLookupForTests(null);
});

async function reserve(amount: number): Promise<Reservation> {
  const r = await checkAndReserve(userId, amount);
  assert.equal(r.allowed, true);
  return (r as { reservation: Reservation }).reservation;
}

test("a reservation holds tokens and settling gives back what wasn't used", async () => {
  const res = await reserve(1_000);
  assert.equal(ledger.reserved, 1_000);
  const meter = new UsageMeter(res, { userId, feature: "chat" });
  await meter.recordCall(pro, { promptTokens: 300, completionTokens: 100, totalTokens: 400 });
  assert.equal(ledger.used, 400);
  assert.equal(ledger.reserved, 600);
  await meter.settle();
  assert.equal(ledger.reserved, 0);
  assert.equal(ledger.used, 400);
  await meter.settle(); // idempotent
  assert.equal(ledger.reserved, 0);
});

test("an agent turn's running totals become one row per round and add up exactly once", async () => {
  const meter = new UsageMeter(await reserve(500), { userId, feature: "chat" });
  const budget = meter.budget(() => pro);
  assert.equal(await budget({ promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 }), null);
  assert.equal(await budget({ promptTokens: 2_200, completionTokens: 250, totalTokens: 2_450, cachedTokens: 900 }), null);
  // The final reconcile re-reports the full total plus the last round: only the new part is added.
  await meter.recordCumulative(pro, { promptTokens: 3_500, completionTokens: 400, totalTokens: 3_900, cachedTokens: 2_000 });
  await meter.recordCumulative(pro, { promptTokens: 3_500, completionTokens: 400, totalTokens: 3_900, cachedTokens: 2_000 });
  await meter.settle();
  assert.equal(ledger.rows.size, 3);
  assert.equal(ledger.used, billableTokens({ promptTokens: 3_500, completionTokens: 400, totalTokens: 3_900, cachedTokens: 2_000 }));
  assert.equal(ledger.reserved, 0);
});

test("a retried write whose first response was lost is not counted twice (same idempotency key)", async () => {
  const meter = new UsageMeter(await reserve(100), { userId, feature: "chat" });
  ledger.failures.push({ fn: "quota_record_usage", afterCommit: true });
  await meter.recordCall(pro, { promptTokens: 1_000, completionTokens: 0, totalTokens: 1_000 });
  assert.equal(ledger.rows.size, 1);
  assert.equal(ledger.used, 1_000);
  assert.equal(meter.billable, 0, "the duplicate confirmation isn't double-counted locally either");
});

test("switching models mid-turn draws on the same allowance", async () => {
  const meter = new UsageMeter(await reserve(100), { userId, feature: "chat" });
  await meter.recordCall(pro, { promptTokens: 4_000, completionTokens: 500, totalTokens: 4_500 });
  await meter.recordCall(claude, { promptTokens: 4_000, completionTokens: 500, totalTokens: 4_500 });
  assert.equal(ledger.used, 9_000);
  const second = await checkAndReserve(userId, 2_000);
  assert.equal(second.allowed, false);
  assert.equal(second.allowed === false && second.reason, "exhausted");
});

test("the next agent round is only started when the balance can hold it", async () => {
  ledger.allowance = 3_000;
  const meter = new UsageMeter(await reserve(1_000), { userId, feature: "build" });
  const budget = meter.budget(() => pro);
  // Round 1 used 2,000; another round that size can't fit in the 1,000 left → stop before calling.
  const stop = await budget({ promptTokens: 1_800, completionTokens: 200, totalTokens: 2_000 });
  assert.match(stop ?? "", /used all of this month's tokens/);
  assert.equal(ledger.used, 2_000);
  await meter.settle();
  assert.equal(ledger.reserved, 0);
});

test("a call that overruns its hold is still recorded in full, and the turn stops", async () => {
  ledger.allowance = 5_000;
  const meter = new UsageMeter(await reserve(1_000), { userId, feature: "build" });
  const budget = meter.budget(() => pro);
  assert.equal(await budget({ promptTokens: 1_800, completionTokens: 200, totalTokens: 2_000 }), null);
  // The second round was far bigger than the round it was held for (2,000): 4,000 more.
  const stop = await budget({ promptTokens: 5_400, completionTokens: 600, totalTokens: 6_000 });
  assert.match(stop ?? "", /used all of this month's tokens/);
  assert.equal(ledger.used, 6_000, "the call happened upstream — it is recorded, not dropped");
  await meter.settle();
  assert.equal(ledger.reserved, 0);
  assert.equal((await checkAndReserve(userId, 1)).allowed, false);
});

test("a ledger outage fails closed: no reservation, and a running turn stops", async () => {
  ledger.failures.push({ fn: "quota_reserve" });
  const refused = await checkAndReserve(userId, 10);
  assert.equal(refused.allowed, false);
  assert.equal(refused.allowed === false && refused.reason, "unavailable");

  const meter = new UsageMeter(await reserve(10), { userId, feature: "chat" });
  ledger.failures.push({ fn: "quota_record_usage" }, { fn: "quota_record_usage" }, { fn: "quota_record_usage" });
  const ok = await meter.recordCall(pro, { promptTokens: 50, completionTokens: 5, totalTokens: 55 });
  assert.equal(ok, false);
  assert.equal(meter.stopReason, "unavailable");
  // When the database comes back, the same row (same key) is written before the hold is released.
  await meter.settle();
  assert.equal(ledger.rows.size, 1);
  assert.equal(ledger.used, 55);
  assert.equal(ledger.reserved, 0);
});

test("a hold that the balance can't cover is refused before the model is called", async () => {
  ledger.allowance = 5_000;
  const meter = new UsageMeter(await reserve(1_000), { userId, feature: "chat" });
  assert.equal(await meter.ensureHold(4_000), true);
  assert.equal(await meter.ensureHold(6_000), false);
  assert.equal(meter.stopReason, "exhausted");
});

test("helper calls inside a turn are metered (estimated); routing probes are recorded but not charged", async () => {
  const meter = new UsageMeter(await reserve(100), { userId, feature: "chat" });
  const messages = [{ role: "user" as const, content: "x".repeat(4_000) }];
  await withMeter(meter, async () => {
    await meteredChat(pro, messages, async () => "y".repeat(400), { chargeable: true });
    await meteredChat(pro, messages, async () => "YES", { chargeable: false });
    await assert.rejects(meteredChat(pro, messages, async () => { throw new Error("502"); }, { chargeable: true }));
  });
  await meter.settle();
  const rows = [...ledger.rows.values()];
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.usage_source, r.call_status, r.billable_tokens]), [
    ["estimated", "ok", 1_100],
    ["estimated", "ok", 0],
    ["none", "failed", 0],
  ]);
  assert.equal(ledger.used, 1_100);
});

test("concurrent fire-and-forget records never skip or duplicate a row", async () => {
  const meter = new UsageMeter(await reserve(100), { userId, feature: "chat" });
  await Promise.all(Array.from({ length: 25 }, (_, i) => meter.recordCall(pro, { promptTokens: 10 + i, completionTokens: 0, totalTokens: 10 + i })));
  await meter.settle();
  assert.equal(ledger.rows.size, 25);
  assert.equal(ledger.used, Array.from({ length: 25 }, (_, i) => 10 + i).reduce((a, b) => a + b, 0));
});
