import assert from "node:assert/strict";
import test from "node:test";
import { hasPermission, isKnownPermission } from "../src/services/console/permissions.js";
import { brandedEmail, renderMarkdown, unsubscribeToken, verifyUnsubscribeToken } from "../src/services/console/mail.js";
import { matchesAudience } from "../src/services/console/announcementService.js";

test("permission matching: wildcard, group wildcard, exact", () => {
  assert.ok(hasPermission(["*"], "team.manage"));
  assert.ok(hasPermission(["crm.*"], "crm.manage"));
  assert.ok(!hasPermission(["crm.*"], "support.view"));
  assert.ok(hasPermission(["support.view"], "support.view"));
  assert.ok(!hasPermission(["support.view"], "support.reply"));
  assert.ok(!hasPermission([], "overview.view"));
});

test("role editor only accepts known permissions", () => {
  assert.ok(isKnownPermission("*"));
  assert.ok(isKnownPermission("marketing.send"));
  assert.ok(isKnownPermission("crm.*"));
  assert.ok(!isKnownPermission("root.everything"));
  assert.ok(!isKnownPermission("nope.*"));
});

test("markdown renderer escapes HTML and only allows safe links", () => {
  const html = renderMarkdown('Hello <script>alert(1)</script> **bold** [ok](https://friday.ai) [bad](javascript:alert(1))');
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes('href="https://friday.ai"'));
  assert.ok(!html.includes("javascript:"));
});

test("markdown renderer handles headings, lists and rules", () => {
  const html = renderMarkdown("# Big news\n\n- one\n- two\n\n1. first\n2. second\n\n---\n\nThanks");
  assert.match(html, /<h1[^>]*>Big news<\/h1>/);
  assert.match(html, /<ul[^>]*>.*<li[^>]*>one<\/li>.*<li[^>]*>two<\/li>.*<\/ul>/s);
  assert.match(html, /<ol[^>]*>.*first.*second.*<\/ol>/s);
  assert.match(html, /<hr/);
  assert.match(html, /<p[^>]*>Thanks<\/p>/);
});

test("branded email escapes the heading and drops unsafe CTA urls", () => {
  const html = brandedEmail({ heading: "<b>Hi</b>", bodyHtml: "<p>x</p>", cta: { label: "Go", url: "javascript:alert(1)" } });
  assert.ok(html.includes("&lt;b&gt;Hi&lt;/b&gt;"));
  assert.ok(!html.includes("javascript:"));
});

test("unsubscribe tokens verify only for the right user", () => {
  const a = "11111111-1111-1111-1111-111111111111";
  const b = "22222222-2222-2222-2222-222222222222";
  const token = unsubscribeToken(a);
  assert.ok(verifyUnsubscribeToken(a, token));
  assert.ok(!verifyUnsubscribeToken(b, token));
  assert.ok(!verifyUnsubscribeToken(a, "short"));
});

test("audience matching for product updates", () => {
  const now = Date.parse("2026-09-29T00:00:00Z");
  const fresh = { plan: "free", createdAt: "2026-09-25T00:00:00Z" };
  const old = { plan: "premium", createdAt: "2025-01-01T00:00:00Z" };
  assert.ok(matchesAudience("all", old, now));
  assert.ok(matchesAudience("free", fresh, now));
  assert.ok(!matchesAudience("free", old, now));
  assert.ok(matchesAudience("paid", old, now));
  assert.ok(matchesAudience("premium", old, now));
  assert.ok(!matchesAudience("pro", old, now));
  assert.ok(matchesAudience("new_users", fresh, now));
  assert.ok(!matchesAudience("new_users", old, now));
  assert.ok(!matchesAudience("martians", old, now));
});
