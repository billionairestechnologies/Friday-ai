import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesAudience, safeCtaUrl } from "../src/services/console/announcementService.js";

test("popup links: in-app paths and https only — never script, data, protocol-relative or http", () => {
  assert.equal(safeCtaUrl("/plans"), "/plans");
  assert.equal(safeCtaUrl("/?support=programs"), "/?support=programs");
  assert.equal(safeCtaUrl("https://friday.example.com/blog/credits"), "https://friday.example.com/blog/credits");
  assert.equal(safeCtaUrl(""), null);
  assert.equal(safeCtaUrl(null), null);
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>", "//evil.example/x", "http://insecure.example", "https://user:pass@evil.example", "/x\" onmouseover=\"alert(1)", "vbscript:msgbox"]) {
    assert.throws(() => safeCtaUrl(bad), /in-app path|https/, bad);
  }
});

test("audience matching is unchanged", () => {
  const now = Date.parse("2026-10-17T00:00:00Z");
  assert.equal(matchesAudience("paid", { plan: "pro", createdAt: "2026-01-01T00:00:00Z" }, now), true);
  assert.equal(matchesAudience("free", { plan: "pro", createdAt: "2026-01-01T00:00:00Z" }, now), false);
  assert.equal(matchesAudience("new_users", { plan: "free", createdAt: "2026-10-10T00:00:00Z" }, now), true);
});
