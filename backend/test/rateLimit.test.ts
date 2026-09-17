import assert from "node:assert/strict";
import test from "node:test";
import { ConcurrencyLimiter, FixedWindowRateLimiter } from "../src/middleware/rateLimit.js";

test("fixed-window limiter blocks requests above its limit", () => {
  const limiter = new FixedWindowRateLimiter(2, 1_000);

  assert.equal(limiter.consume("user-1", 1_000).allowed, true);
  assert.equal(limiter.consume("user-1", 1_100).allowed, true);
  const blocked = limiter.consume("user-1", 1_200);

  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.resetAt, 2_000);
});

test("fixed-window limiter isolates keys and resets expired windows", () => {
  const limiter = new FixedWindowRateLimiter(1, 1_000);

  assert.equal(limiter.consume("user-1", 1_000).allowed, true);
  assert.equal(limiter.consume("user-2", 1_100).allowed, true);
  assert.equal(limiter.consume("user-1", 2_000).allowed, true);
});

test("concurrency limiter releases capacity independently per key", () => {
  const limiter = new ConcurrencyLimiter(1);

  assert.equal(limiter.acquire("user-1"), true);
  assert.equal(limiter.acquire("user-1"), false);
  assert.equal(limiter.acquire("user-2"), true);
  limiter.release("user-1");
  assert.equal(limiter.acquire("user-1"), true);
});
