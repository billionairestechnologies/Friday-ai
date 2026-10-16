import assert from "node:assert/strict";
import test from "node:test";
import { ledgerFeatureFor } from "../src/services/quota/tokenQuotaService.js";

test("Air Dots conversations are metered as air, other origins keep their feature", () => {
  assert.equal(ledgerFeatureFor("air", "chat"), "air");
  assert.equal(ledgerFeatureFor("air", "build"), "air");
  assert.equal(ledgerFeatureFor("web", "chat"), "chat");
  assert.equal(ledgerFeatureFor("web", "build"), "build");
  assert.equal(ledgerFeatureFor(null, "research"), "research");
  assert.equal(ledgerFeatureFor(undefined, "chat"), "chat");
});
