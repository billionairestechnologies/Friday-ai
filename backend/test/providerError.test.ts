import assert from "node:assert/strict";
import test from "node:test";
import { friendlyProviderError } from "../src/utils/providerError.js";

test("a Cloudflare 502 HTML page becomes a friendly line with no vendor name or markup", () => {
  const raw = 'scalemax: ScaleMax chat failed: 502 <!DOCTYPE html><html><head><title>api.scalemax.pro | 502: Bad gateway</title></head><body>' + "x".repeat(5000) + "</body></html>";
  const out = friendlyProviderError(raw);
  assert.match(out, /high usage/i);
  assert.ok(!/scalemax|cloudflare|[<>]/i.test(out), out);
});

test("rate limits, timeouts and 5xx all read as high usage", () => {
  for (const raw of ["openai: OpenAI chat failed: 429 rate limited", "anthropic: Anthropic chat failed: 503 {}", "gemini: fetch failed", "x: request timed out"]) {
    assert.match(friendlyProviderError(raw), /high usage/i, raw);
  }
});

test("rejected keys never expose the vendor; oversized payloads say so", () => {
  assert.match(friendlyProviderError("openai: OpenAI chat failed: 401 invalid api key"), /isn't available right now/);
  assert.match(friendlyProviderError('scalemax: ScaleMax chat failed: 400 {"message":"Check payload size"}'), /too large/i);
});

test("short wording callers match on survives, minus the vendor prefix", () => {
  assert.equal(friendlyProviderError("fake: tools not supported"), "tools not supported");
  assert.ok(friendlyProviderError("x: <b>bad</b>\nsecond line").length < 50);
});

test("an exhausted provider balance (402) is never quoted to the user", () => {
  const out = friendlyProviderError('scalemax: ScaleMax chat failed: 402 {"error":{"message":"Token allocation is too low. Renew this token pack"}}');
  assert.match(out, /isn't available right now/);
  assert.ok(!/token|renew|scalemax/i.test(out), out);
});

test("the raw quota JSON from the screenshot is replaced; Friday's own limit messages are left alone", async () => {
  const { sanitizeUserError, classifyProviderIssue } = await import("../src/utils/providerError.js");
  const raw = '{"type":"error","error":{"type":"quota_error","message":"Your token pack is almost used up (the reply would be cut off mid-way). Top up or renew your pack and retry.","request_id":"2e6efae3"}}';
  const shown = sanitizeUserError(raw);
  assert.match(shown, /isn't available right now/);
  assert.ok(!/token|pack|renew|quota|request_id/i.test(shown), shown);
  assert.equal(classifyProviderIssue(raw), "quota");
  const own = "You've reached your daily limit on the Free plan. Upgrade to keep going.";
  assert.equal(sanitizeUserError(own), own);
  assert.equal(sanitizeUserError("Claude Opus doesn't support images."), "Claude Opus doesn't support images.");
});

test("issue kinds are classified for the admin log", async () => {
  const { classifyProviderIssue } = await import("../src/utils/providerError.js");
  assert.equal(classifyProviderIssue("scalemax: ScaleMax chat failed: 502 <html>"), "gateway");
  assert.equal(classifyProviderIssue("openai: OpenAI chat failed: 429 slow down"), "rate_limit");
  assert.equal(classifyProviderIssue("gemini: Gemini chat failed: 403 API key not valid"), "auth");
});

test("a .csv labelled application/vnd.ms-excel is read as text, real spreadsheets and images are not", async () => {
  const { isPlainTextDocument } = await import("../src/services/providers/plainTextDocs.js");
  assert.equal(isPlainTextDocument("application/vnd.ms-excel", "Friday email lead.csv"), true);
  assert.equal(isPlainTextDocument("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "leads.csv"), false);
  assert.equal(isPlainTextDocument("application/vnd.ms-excel", "budget.xls"), false);
  assert.equal(isPlainTextDocument("image/png", "chart.csv"), false);
});
