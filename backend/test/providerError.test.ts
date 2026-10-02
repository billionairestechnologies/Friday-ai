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
