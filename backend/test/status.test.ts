import { test } from "node:test";
import assert from "node:assert/strict";
import { componentStatusFrom, crashFingerprint, uptimePercent } from "../src/services/status/statusService.js";

test("component status: one failed probe is degraded, two in a row is an outage", () => {
  assert.equal(componentStatusFrom([], false), "unknown");
  assert.equal(componentStatusFrom([{ ok: true }, { ok: false }], false), "operational");
  assert.equal(componentStatusFrom([{ ok: true }], true), "degraded"); // an open incident says otherwise
  assert.equal(componentStatusFrom([{ ok: false }, { ok: true }], false), "degraded");
  assert.equal(componentStatusFrom([{ ok: false }, { ok: false }], false), "outage");
});

test("uptime is the share of passing probes, to two decimals", () => {
  assert.equal(uptimePercent([]), null);
  assert.equal(uptimePercent([{ total: 288, ok: 288 }]), 100);
  assert.equal(uptimePercent([{ total: 288, ok: 287 }, { total: 288, ok: 288 }]), 99.83);
});

test("crash fingerprints group the same crash despite varying ids, numbers and line numbers", () => {
  const a = crashFingerprint("web", "Cannot read properties of undefined (reading 'id') at row 12", "TypeError\n    at renderRow (https://app/assets/index-abc.js:10:2044)");
  const b = crashFingerprint("web", "Cannot read properties of undefined (reading 'name') at row 99", "TypeError\n    at renderRow (https://app/assets/index-abc.js:10:9911)");
  const other = crashFingerprint("web", "Cannot read properties of undefined (reading 'id') at row 12", "TypeError\n    at renderList (https://app/assets/index-abc.js:10:2044)");
  assert.equal(a, b);
  assert.notEqual(a, other);
  assert.notEqual(a, crashFingerprint("android", "Cannot read properties of undefined (reading 'id') at row 12", "TypeError\n    at renderRow (https://app/assets/index-abc.js:10:2044)"));
});
