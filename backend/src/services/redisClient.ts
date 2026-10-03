import { createClient, type RedisClientType } from "redis";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

let client: RedisClientType | null = null;
let connectAttempt: Promise<RedisClientType | null> | null = null;

/** Test-only: lets quota tests run the real accounting against an in-memory fake instead of a server. */
let testOverride: RedisClientType | null = null;
export function setRedisClientForTests(fake: unknown | null) {
  testOverride = fake as RedisClientType | null;
}

export function redisConfigured(): boolean {
  return Boolean(env.redisUrl) || testOverride !== null;
}

export async function getRedisClient(): Promise<RedisClientType | null> {
  if (testOverride) return testOverride;
  if (!env.redisUrl) return null;
  if (client?.isOpen) return client;
  if (connectAttempt) return connectAttempt;

  connectAttempt = (async () => {
    const next = createClient({ url: env.redisUrl });
    next.on("error", (error) => {
      logger.warn("redis_client_error", { error: error instanceof Error ? error.message : String(error) });
    });
    try {
      await next.connect();
      client = next as RedisClientType;
      logger.info("redis_connected");
      return client;
    } catch (error) {
      logger.warn("redis_connect_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      connectAttempt = null;
      try {
        await next.disconnect();
      } catch {
        // ignore disconnect errors during failed connect
      }
      return null;
    }
  })();

  return connectAttempt;
}

export async function redisPing(): Promise<"ok" | "unavailable" | "disabled"> {
  if (!env.redisUrl) return "disabled";
  const redis = await getRedisClient();
  if (!redis) return "unavailable";
  try {
    const pong = await redis.ping();
    return pong === "PONG" ? "ok" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function closeRedisClient() {
  if (client?.isOpen) {
    await client.quit();
  }
  client = null;
  connectAttempt = null;
}
