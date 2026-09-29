import assert from "node:assert/strict";
import test from "node:test";
import { emailMatchesDomains, endsAtFor, generateCode, normalizeCode } from "../src/services/console/plansService.js";

test("student/partner email domains match the domain and its subdomains only", () => {
  assert.ok(emailMatchesDomains("a@mit.edu", ["edu"]));
  assert.ok(emailMatchesDomains("a@cs.iitb.ac.in", ["ac.in"]));
  assert.ok(emailMatchesDomains("a@iitb.ac.in", ["@iitb.ac.in"]));
  assert.ok(emailMatchesDomains("a@acme.com", ["acme.com"]));
  assert.ok(!emailMatchesDomains("a@notacme.com", ["acme.com"]));
  assert.ok(!emailMatchesDomains("a@edu.fake.com", ["edu"]));
  assert.ok(!emailMatchesDomains(null, ["edu"]));
});

test("offer codes are normalised and generated codes are well-formed", () => {
  assert.equal(normalizeCode("  student-2026 "), "STUDENT-2026");
  assert.equal(normalizeCode("a b$c"), "ABC");
  assert.match(generateCode("student"), /^STUDENT-[0-9A-F]{8}$/);
  assert.match(generateCode(""), /^FRIDAY-[0-9A-F]{8}$/);
});

test("grant end dates", () => {
  assert.equal(endsAtFor(null), null);
  assert.equal(endsAtFor(30, Date.parse("2026-01-01T00:00:00Z")), "2026-01-31T00:00:00.000Z");
});
