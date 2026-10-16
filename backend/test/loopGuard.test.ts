import { test } from "node:test";
import assert from "node:assert/strict";
import { LoopGuard, roundSignature, turnTokenCap } from "../src/services/agent/loopGuard.js";

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

test("per-turn runaway guard is a share of the monthly allowance, none without one", () => {
  assert.equal(turnTokenCap(10_000_000), 3_000_000);
  assert.equal(turnTokenCap(undefined), null);
  assert.equal(turnTokenCap(0), null);
});
