import type { Socket } from "node:net";
import { assertEnvironmentConfigured, env } from "./config/env.js";
import { beginShutdown } from "./services/lifecycle.js";

assertEnvironmentConfigured();

const { createApp } = await import("./app.js");
const app = createApp();
const sockets = new Set<Socket>();

const server = app.listen(env.port, () => {
  console.log(`Friday AI backend listening on http://localhost:${env.port}`);
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
  process.exitCode = exitCode;
  console.log(`Shutting down Friday AI backend (${reason})`);

  const forceTimer = setTimeout(() => {
    console.error("Graceful shutdown timed out; closing remaining connections");
    for (const socket of sockets) socket.destroy();
  }, 10_000);

  server.closeIdleConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(forceTimer);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  void shutdown("unhandledRejection", 1);
});
