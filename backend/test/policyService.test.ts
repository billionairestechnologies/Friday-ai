import assert from "node:assert/strict";
import test from "node:test";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key";
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "anon-key";

const { POLICY_VERSION, policyIsCurrent } = await import("../src/services/policyService.js");

test("an account that never agreed (null) is never current", () => {
  assert.equal(policyIsCurrent(null), false);
  assert.equal(policyIsCurrent(undefined), false);
});

test("an account on an older version is not current", () => {
  assert.equal(policyIsCurrent("2020-01-01"), false);
});

test("an account on today's POLICY_VERSION is current", () => {
  assert.equal(policyIsCurrent(POLICY_VERSION), true);
});

test("POLICY_VERSION is a real dated version string", () => {
  assert.match(POLICY_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});
