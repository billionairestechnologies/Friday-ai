import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTokens, needsApproval, validateGrant, type CreditSettings } from "../src/services/quota/credits.js";
import { percentUsed, remainingOf, snapshotFromRow } from "../src/services/quota/allowance.js";

const settings: CreditSettings = { approvalThresholdTokens: 10_000_000, maxGrantTokens: 100_000_000, bulkMaxRecipients: 5_000 };
const NOW = Date.parse("2026-10-17T12:00:00Z");

test("grants above the threshold (one grant or a whole batch) need a second approver", () => {
  assert.equal(needsApproval(10_000_000, settings), false, "at the threshold is fine");
  assert.equal(needsApproval(10_000_001, settings), true);
  assert.equal(needsApproval(2_000 * 10_000, settings), true, "a bulk batch is judged by its total");
});

test("grant input: whole positive tokens, under the cap, future expiry, a reason", () => {
  const ok = { tokens: 1_000_000, expiresAt: new Date(NOW + 86_400_000).toISOString(), reason: "Launch thank-you" };
  assert.doesNotThrow(() => validateGrant(ok, settings, NOW));
  assert.doesNotThrow(() => validateGrant({ ...ok, expiresAt: null }, settings, NOW), "no expiry is allowed");
  for (const [patch, msg] of [
    [{ tokens: 0 }, /above 0/],
    [{ tokens: 1.5 }, /whole number/],
    [{ tokens: 100_000_001 }, /can't exceed/],
    [{ expiresAt: new Date(NOW - 1).toISOString() }, /future/],
    [{ expiresAt: "not a date" }, /Invalid expiry/],
    [{ reason: "  " }, /why/],
  ] as const) {
    assert.throws(() => validateGrant({ ...ok, ...patch }, settings, NOW), msg, JSON.stringify(patch));
  }
});

test("token amounts read naturally in notifications", () => {
  assert.equal(formatTokens(5_000_000), "5M");
  assert.equal(formatTokens(2_500_000), "2.5M");
  assert.equal(formatTokens(250_000), "250K");
  assert.equal(formatTokens(999), "999");
});

test("the TypeScript balance mirror matches quota_remaining (credits on top, the meter shows only the allowance)", () => {
  const s = { allowance: 1_000_000, used: 1_100_000, adjustments: 0, reserved: 50_000, credits: 400_000, creditDrawn: 100_000 };
  assert.equal(remainingOf(s), 1_000_000 + 100_000 + 400_000 - 1_100_000 - 0 - 50_000);
  assert.equal(percentUsed(s), 100, "the month's allowance is used up; credits paid the rest");
  assert.equal(remainingOf({ allowance: 10, used: 3, adjustments: 1, reserved: 2 }), 4, "no credits → 0057's rule");
  const parsed = snapshotFromRow({ account_id: "a", plan: "free", allowance: 1, used: 0, adjustments: 0, reserved: 0, credits: "400000", credit_drawn: 5, remaining: 1, period_start: "2026-10-17T00:00:00Z", period_end: "2026-11-17T00:00:00Z", status: "active" });
  assert.equal(parsed.credits, 400_000);
  assert.equal(parsed.creditDrawn, 5);
});
