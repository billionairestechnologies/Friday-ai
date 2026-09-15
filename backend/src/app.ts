import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { adminProvidersRouter } from "./routes/adminProviders.js";
import { modelsRouter } from "./routes/models.js";
import { chatRouter } from "./routes/chat.js";
import { voiceRouter } from "./routes/voice.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In production this server also serves the built frontend (../../frontend/dist relative to
// backend/dist/app.js) so the whole app runs as one deployable service on one port. Absent in
// local dev, where the frontend runs on its own Vite dev server instead.
const frontendDist = path.join(__dirname, "../../frontend/dist");

export function createApp() {
  const app = express();

  // Content-Security-Policy defaults would block the app's Google Fonts stylesheet/font files,
  // which are same-origin-safe but hosted externally; the rest of Helmet's protections still apply.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json({ limit: "2mb" }));
  app.use(morgan("dev"));

  app.use("/api/health", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/admin/providers", adminProvidersRouter);
  app.use("/api/models", modelsRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/voice", voiceRouter);

  if (existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  }

  app.use(errorHandler);
  return app;
}
