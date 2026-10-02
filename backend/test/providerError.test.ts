import assert from "node:assert/strict";
import test from "node:test";
import { friendlyProviderError } from "../src/utils/providerError.js";

test("a Cloudflare 502 HTML page becomes one readable line", () => {
  const raw = 'scalemax: ScaleMax chat failed: 502 <!DOCTYPE html><html><head><title>api.scalemax.pro | 502: Bad gateway</title></head><body>' + "x".repeat(5000) + "</body></html>";
  const out = friendlyProviderError(raw);
  assert.ok(out.length < 200, out);
  assert.ok(!/[<>]/.test(out), out);
  assert.match(out, /Scalemax is temporarily unavailable/);
});

test("400 payload-size rejection explains what to do", () => {
  const out = friendlyProviderError('scalemax: ScaleMax chat failed: 400 {"error":{"message":"Check the request parameters, tool definitions and payload size"}}');
  assert.match(out, /too large|rejected/i);
});

test("unknown errors keep one short line, never markup", () => {
  assert.equal(friendlyProviderError("openai: connection reset"), "openai: connection reset");
  assert.ok(friendlyProviderError("x: <b>bad</b>\nsecond line").length < 50);
});
