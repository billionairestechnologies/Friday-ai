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

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json({ limit: "2mb" }));
  app.use(morgan("dev"));

  app.use("/api/health", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/admin/providers", adminProvidersRouter);
  app.use("/api/models", modelsRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/voice", voiceRouter);

  app.use(errorHandler);
  return app;
}
