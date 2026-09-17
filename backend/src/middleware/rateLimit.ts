import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { getRedisClient, redisConfigured } from "../services/redisClient.js";

type Bucket = {
  count: number;
  resetAt: number;
};

export type LimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
};

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private operations = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxEntries = 100_000,
  ) {}

  consume(key: string, now = Date.now()): LimitResult {
    this.operations += 1;
    if (this.operations % 1_000 === 0 || this.buckets.size >= this.maxEntries) {
      this.removeExpired(now);
      if (this.buckets.size >= this.maxEntries) {
        const oldestKey = this.buckets.keys().next().value as string | undefined;
        if (oldestKey) this.buckets.delete(oldestKey);
      }
    }

    const existing = this.buckets.get(key);
    const bucket =
      !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + this.windowMs }
        : existing;

    bucket.count += 1;
    this.buckets.set(key, bucket);

    return {
      allowed: bucket.count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - bucket.count),
      resetAt: bucket.resetAt,
    };
  }

  private removeExpired(now: number) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

export class ConcurrencyLimiter {
  private readonly active = new Map<string, number>();

  constructor(private readonly limit: number) {}

  acquire(key: string): boolean {
    const count = this.active.get(key) ?? 0;
    if (count >= this.limit) return false;
    this.active.set(key, count + 1);
    return true;
  }

  release(key: string) {
    const count = this.active.get(key) ?? 0;
    if (count <= 1) this.active.delete(key);
    else this.active.set(key, count - 1);
  }
}

class RedisFixedWindowRateLimiter {
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  async consume(key: string): Promise<LimitResult | null> {
    const redis = await getRedisClient();
    if (!redis) return null;

    const redisKey = `rl:fw:${key}`;
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.pExpire(redisKey, this.windowMs);
    }
    const ttl = await redis.pTTL(redisKey);
    const resetAt = Date.now() + Math.max(ttl, 0);

    return {
      allowed: count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - count),
      resetAt,
    };
  }
}

class RedisConcurrencyLimiter {
  constructor(private readonly limit: number) {}

  async acquire(key: string): Promise<boolean | null> {
    const redis = await getRedisClient();
    if (!redis) return null;

    const redisKey = `rl:cc:${key}`;
    const count = await redis.incr(redisKey);
    if (count > this.limit) {
      await redis.decr(redisKey);
      return false;
    }
    // Recover from crashed holders; active chat/voice/sandbox runs should finish sooner.
    // Only refreshed on a successful acquire — a rejected attempt must never extend a stale
    // holder's TTL, or a stuck key from a killed process never expires while someone keeps retrying.
    await redis.expire(redisKey, 15 * 60);
    return true;
  }

  async release(key: string) {
    const redis = await getRedisClient();
    if (!redis) return;
    const redisKey = `rl:cc:${key}`;
    const count = await redis.decr(redisKey);
    if (count <= 0) await redis.del(redisKey);
  }
}

type RateLimitOptions = {
  name: string;
  limit: number;
  windowMs: number;
  key?: (req: Request) => string;
};

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function clientKey(req: Request): string {
  return req.user?.id ?? req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export function credentialKey(req: Request): string {
  const body = req.body as { email?: unknown } | undefined;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  return `${clientKey(req)}:${email}`;
}

function applyLimitHeaders(res: import("express").Response, result: LimitResult, windowMs: number) {
  res.setHeader("RateLimit-Policy", `${result.limit};w=${Math.ceil(windowMs / 1_000)}`);
  res.setHeader("RateLimit-Limit", String(result.limit));
  res.setHeader("RateLimit-Remaining", String(result.remaining));
  res.setHeader("RateLimit-Reset", String(Math.ceil(result.resetAt / 1_000)));
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const memory = new FixedWindowRateLimiter(options.limit, options.windowMs);
  const redisLimiter = redisConfigured() ? new RedisFixedWindowRateLimiter(options.limit, options.windowMs) : null;

  return (req, res, next) => {
    const rawKey = options.key?.(req) ?? clientKey(req);
    const key = hashKey(`${options.name}:${rawKey}`);

    void (async () => {
      let result: LimitResult | null = null;
      if (redisLimiter) {
        try {
          result = await redisLimiter.consume(key);
        } catch {
          result = null;
        }
      }
      if (!result) result = memory.consume(key);

      applyLimitHeaders(res, result, options.windowMs);
      if (!result.allowed) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1_000))));
        res.status(429).json({
          error: "Too many requests. Please wait and try again.",
          requestId: req.requestId,
        });
        return;
      }
      next();
    })().catch(next);
  };
}

export function concurrencyLimit(name: string, limit: number): RequestHandler {
  const memory = new ConcurrencyLimiter(limit);
  const redisLimiter = redisConfigured() ? new RedisConcurrencyLimiter(limit) : null;

  return (req, res, next) => {
    const key = hashKey(`${name}:${clientKey(req)}`);

    void (async () => {
      let acquired: boolean | null = null;
      if (redisLimiter) {
        try {
          acquired = await redisLimiter.acquire(key);
        } catch {
          acquired = null;
        }
      }
      if (acquired === null) acquired = memory.acquire(key);

      if (!acquired) {
        res.setHeader("Retry-After", "1");
        res.status(429).json({
          error: "Too many requests are already running. Wait for one to finish.",
          requestId: req.requestId,
        });
        return;
      }

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (redisLimiter) {
          void redisLimiter.release(key).catch(() => memory.release(key));
        } else {
          memory.release(key);
        }
      };
      res.once("finish", release);
      res.once("close", release);
      next();
    })().catch(next);
  };
}
