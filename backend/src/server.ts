import type { Socket } from "node:net";
import { assertEnvironmentConfigured, env } from "./config/env.js";
import { beginShutdown } from "./services/lifecycle.js";
import { closeRedisClient } from "./services/redisClient.js";
import { logger } from "./utils/logger.js";

assertEnvironmentConfigured();

const { createApp } = await import("./app.js");
const { startAutomationScheduler, stopAutomationScheduler } = await import("./services/automations/automationService.js");
const { startCampaignScheduler } = await import("./services/console/campaignService.js");
const { startGrantExpirySweep } = await import("./services/console/plansService.js");
const { startStatusMonitor } = await import("./services/status/statusService.js");
const { startTurnSweeper, stopTurnSweeper } = await import("./services/jobs/sweeper.js");
const { drainTurns } = await import("./services/jobs/turns.js");
const app = createApp();
const sockets = new Set<Socket>();

const server = app.listen(env.port, () => {
  logger.info("server_listening", {
    port: env.port,
    redis: env.redisUrl ? "configured" : "disabled",
  });
  startAutomationScheduler();
  startCampaignScheduler();
  startGrantExpirySweep();
  startStatusMonitor();
  startTurnSweeper();
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
  stopTurnSweeper();
  process.exitCode = exitCode;
  logger.info("server_shutdown_started", { reason });

  // Running chat/research/Build turns get a short grace period to finish; whatever is still running
  // is handed over (another instance — or this service after it restarts — resumes Builds, and
  // reports the rest as interrupted). Keep FRIDAY_DRAIN_SECONDS below the platform's kill timeout.
  await drainTurns(Number(process.env.FRIDAY_DRAIN_SECONDS ?? 20) * 1000).catch(() => undefined);

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
