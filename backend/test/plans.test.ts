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

import { DEFAULT_ENTITLEMENTS, annualPricePaise, mergeEntitlements, planFromRow, sanitizeEntitlements } from "../src/services/quota/planCatalog.js";

test("entitlement JSON from admins is sanitized: known keys, right types, clamped", () => {
  assert.deepEqual(
    sanitizeEntitlements({ buildMode: false, buildMaxRounds: -5, deepResearchPerDay: 12.6, teamUpModels: "9", nonsense: true, prioritySupport: 1 }),
    { buildMode: false, buildMaxRounds: 0, deepResearchPerDay: 13 },
  );
  assert.deepEqual(sanitizeEntitlements(null), {});
  assert.deepEqual(sanitizeEntitlements([1, 2]), {});
});

test("entitlement layers: plan ← catalog ← organization ← personal package", () => {
  const merged = mergeEntitlements(DEFAULT_ENTITLEMENTS.free, { buildMaxRounds: 60 }, { documentsPerDay: 50 }, { buildMaxRounds: 120, bogus: 1 } as never);
  assert.equal(merged.buildMaxRounds, 120);
  assert.equal(merged.documentsPerDay, 50);
  assert.equal(merged.customSkills, DEFAULT_ENTITLEMENTS.free.customSkills);
  assert.equal("bogus" in merged, false);
});

test("catalog rows fall back to code defaults for anything unset", () => {
  const plan = planFromRow({
    id: "pro", name: "Pro+", tagline: "", monthly_price_paise: 149_900, annual_discount_percent: 20, min_seats: 7,
    features: [], badge: "", highlight: true, weekly_tokens: 3_000_000, rolling_tokens: null, monthly_tokens: null,
    tokens_per_seat: 99, entitlements: { deepResearchPerDay: 5 }, active: true, sort_order: 1,
  });
  assert.equal(plan.name, "Pro+");
  assert.equal(plan.minSeats, null); // seats only mean something for enterprise
  assert.equal(plan.badge, null);
  assert.ok(plan.features.length > 0);
  assert.equal(plan.limits.weekly, 3_000_000);
  assert.equal(plan.limits.rolling, 60_000);
  assert.equal(plan.limits.monthly, 450_000);
  assert.equal(plan.limits.tokensPerSeat, null);
  assert.equal(plan.entitlements.deepResearchPerDay, 5);
  assert.equal(plan.entitlements.buildMaxRounds, DEFAULT_ENTITLEMENTS.pro.buildMaxRounds);
  assert.equal(annualPricePaise(plan), Math.round(149_900 * 12 * 0.8));
});
