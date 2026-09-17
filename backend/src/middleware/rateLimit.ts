import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";

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

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const limiter = new FixedWindowRateLimiter(options.limit, options.windowMs);

  return (req, res, next) => {
    const rawKey = options.key?.(req) ?? clientKey(req);
    const result = limiter.consume(hashKey(`${options.name}:${rawKey}`));

    res.setHeader("RateLimit-Policy", `${result.limit};w=${Math.ceil(options.windowMs / 1_000)}`);
    res.setHeader("RateLimit-Limit", String(result.limit));
    res.setHeader("RateLimit-Remaining", String(result.remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil(result.resetAt / 1_000)));

    if (!result.allowed) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1_000))));
      res.status(429).json({
        error: "Too many requests. Please wait and try again.",
        requestId: req.requestId,
      });
      return;
    }

    next();
  };
}

export function concurrencyLimit(name: string, limit: number): RequestHandler {
  const limiter = new ConcurrencyLimiter(limit);

  return (req, res, next) => {
    const key = hashKey(`${name}:${clientKey(req)}`);
    if (!limiter.acquire(key)) {
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
      limiter.release(key);
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}
