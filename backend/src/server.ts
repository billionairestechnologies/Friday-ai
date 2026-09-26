import type { Socket } from "node:net";
import { assertEnvironmentConfigured, env } from "./config/env.js";
import { beginShutdown } from "./services/lifecycle.js";
import { closeRedisClient } from "./services/redisClient.js";
import { logger } from "./utils/logger.js";

assertEnvironmentConfigured();

const { createApp } = await import("./app.js");
const { startAutomationScheduler, stopAutomationScheduler } = await import("./services/automations/automationService.js");
const app = createApp();
const sockets = new Set<Socket>();

const server = app.listen(env.port, () => {
  logger.info("server_listening", {
    port: env.port,
    redis: env.redisUrl ? "configured" : "disabled",
  });
  startAutomationScheduler();
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

let shutdownStarted = false;
async function shutdown(reason: string, exitCode = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  beginShutdown();
  stopAutomationScheduler();
  process.exitCode = exitCode;
  logger.info("server_shutdown_started", { reason });

  const forceTimer = setTimeout(() => {
    logger.error("server_shutdown_timeout", { activeConnections: sockets.size });
    for (const socket of sockets) socket.destroy();
  }, 10_000);

  server.closeIdleConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeRedisClient().catch(() => undefined);
  clearTimeout(forceTimer);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", { error: error.stack });
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", { reason });
  void shutdown("unhandledRejection", 1);
});
