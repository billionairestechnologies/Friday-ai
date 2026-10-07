import assert from "node:assert/strict";
import test from "node:test";
import { decidePurchase, decideRollover, purchaseBlockedReason, stateFromRow, type PlanState } from "../src/services/billing/planSchedule.js";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-06T12:00:00Z");
const inDays = (d: number) => new Date(now.getTime() + d * DAY);
const prices = { pro: 99_900, premium: 199_900 };
const state = (p: Partial<PlanState>): PlanState => ({ plan: "free", renewsAt: null, scheduledPlan: null, scheduledDays: null, ...p });

test("Premium subscriber buying Pro: Pro waits until Premium ends (the reported bug)", () => {
  const d = decidePurchase(state({ plan: "premium", renewsAt: inDays(20) }), { plan: "pro", days: 30, monthlyPricePaise: prices }, now);
  assert.equal(d.kind, "schedule");
  if (d.kind !== "schedule") return;
  assert.equal(d.plan, "pro");
  assert.equal(d.startsAt.getTime(), inDays(20).getTime());
  assert.equal(d.days, 30);
});

test("buying the same lower plan twice stacks the scheduled days", () => {
  const d = decidePurchase(state({ plan: "premium", renewsAt: inDays(5), scheduledPlan: "pro", scheduledDays: 30 }), { plan: "pro", days: 30, monthlyPricePaise: prices }, now);
  assert.ok(d.kind === "schedule" && d.days === 60);
});

test("upgrade starts now and credits unused days at the price ratio", () => {
  const d = decidePurchase(state({ plan: "pro", renewsAt: inDays(20) }), { plan: "premium", days: 30, monthlyPricePaise: prices }, now);
  assert.equal(d.kind, "apply");
  if (d.kind !== "apply") return;
  assert.equal(d.plan, "premium");
  assert.equal(d.creditedDays, 9); // 20 days of ₹999 ≈ 9.99 days of ₹1,999
  assert.equal(d.renewsAt.getTime(), inDays(39).getTime());
});

test("renewing the same plan early adds to the end, never resets", () => {
  const d = decidePurchase(state({ plan: "pro", renewsAt: inDays(10) }), { plan: "pro", days: 30, monthlyPricePaise: prices }, now);
  assert.ok(d.kind === "extend" && d.renewsAt.getTime() === inDays(40).getTime());
});

test("an expired or free account gets the plan immediately", () => {
  for (const s of [state({}), state({ plan: "premium", renewsAt: inDays(-1) })]) {
    const d = decidePurchase(s, { plan: "pro", days: 30, monthlyPricePaise: prices }, now);
    assert.ok(d.kind === "apply" && d.plan === "pro" && d.renewsAt.getTime() === inDays(30).getTime());
  }
});

test("checkout refuses a plan that would overwrite a different booked plan", () => {
  const s = state({ plan: "premium", renewsAt: inDays(5), scheduledPlan: "pro", scheduledDays: 30 });
  assert.equal(purchaseBlockedReason(s, "pro", now), null); // more Pro stacks
  assert.equal(purchaseBlockedReason(s, "premium", now), null); // extending Premium pushes Pro later
  assert.equal(purchaseBlockedReason(state({ plan: "premium", renewsAt: inDays(5) }), "pro", now), null);
});

test("at period end the booked plan starts from the old end date; without one, lapse after grace", () => {
  const ended = inDays(-0.5);
  const roll = decideRollover(state({ plan: "premium", renewsAt: ended, scheduledPlan: "pro", scheduledDays: 30 }), now, DAY);
  assert.ok(roll.kind === "start_scheduled" && roll.plan === "pro" && roll.renewsAt.getTime() === ended.getTime() + 30 * DAY);
  assert.equal(decideRollover(state({ plan: "pro", renewsAt: ended }), now, DAY).kind, "none"); // inside 24h grace
  assert.equal(decideRollover(state({ plan: "pro", renewsAt: inDays(-2) }), now, DAY).kind, "lapse");
  assert.equal(decideRollover(state({ plan: "pro", renewsAt: inDays(3) }), now, DAY).kind, "none");
  assert.equal(decideRollover(state({ plan: "pro", renewsAt: null }), now, DAY).kind, "none"); // open-ended grant
});

test("rows from before migration 0054 read as no scheduled plan", () => {
  const s = stateFromRow({ plan: "premium", plan_renews_at: "2026-11-01T00:00:00.123456+00:00", scheduled_plan: null, scheduled_plan_days: null });
  assert.equal(s.scheduledPlan, null);
  assert.equal(s.renewsAtRaw, "2026-11-01T00:00:00.123456+00:00");
});
