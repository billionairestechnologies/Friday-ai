import { test } from "node:test";
import assert from "node:assert/strict";
import { LoopGuard, roundSignature, turnCreditCap } from "../src/services/agent/loopGuard.js";

test("signature ignores call order and argument key order", () => {
  const a = roundSignature([{ name: "read", args: { path: "a", n: 1 } }, { name: "ls", args: {} }]);
  const b = roundSignature([{ name: "ls" }, { name: "read", args: { n: 1, path: "a" } }]);
  assert.equal(a, b);
  assert.notEqual(a, roundSignature([{ name: "read", args: { path: "b", n: 1 } }, { name: "ls" }]));
});

test("stops after three identical rounds in a row, and any different round resets the count", () => {
  const g = new LoopGuard(3);
  const same = [{ name: "run_command", args: { cmd: "npm test" } }];
  assert.equal(g.record(same), false);
  assert.equal(g.record(same), false);
  assert.equal(g.record([{ name: "edit_file", args: { path: "x" } }]), false); // progress — resets
  assert.equal(g.record(same), false);
  assert.equal(g.record(same), false);
  assert.equal(g.record(same), true);
});

test("per-turn cap is a share of the 5-hour window, none without one", () => {
  assert.equal(turnCreditCap(60_000), 48_000);
  assert.equal(turnCreditCap(undefined), null);
  assert.equal(turnCreditCap(0), null);
});
