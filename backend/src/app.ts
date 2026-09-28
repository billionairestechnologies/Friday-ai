import { existsSync, readFileSync, statSync } from "node:fs";
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
import { adminQuotaRouter } from "./routes/adminQuota.js";
import { modelsRouter } from "./routes/models.js";
import { chatRouter, shareRouter } from "./routes/chat.js";
import { pushRouter } from "./routes/push.js";
import { libraryRouter } from "./routes/library.js";
import { memoryRouter } from "./routes/memory.js";
import { automationsRouter } from "./routes/automations.js";
import { mcpRouter } from "./routes/mcp.js";
import { buildRouter } from "./routes/build.js";
import { voiceRouter } from "./routes/voice.js";
import { sandboxRouter } from "./routes/sandbox.js";
import { requestContext } from "./middleware/requestContext.js";
import { usageRouter } from "./routes/usage.js";
import { projectsRouter } from "./routes/projects.js";
import { billingRouter } from "./routes/billing.js";
import { connectorsRouter } from "./routes/connectors.js";
import { organizationsRouter } from "./routes/organizations.js";
import { appRouter } from "./routes/app.js";
import { renderIndexHtml, robotsTxt, sitemapXml } from "./seo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In production this server also serves the built frontend (../../frontend/dist relative to
// backend/dist/app.js) so the whole app runs as one deployable service on one port. Absent in
// local dev, where the frontend runs on its own Vite dev server instead.
const frontendDist = path.join(__dirname, "../../frontend/dist");

export function createApp() {
  const app = express();

  if (env.trustProxy) {
    const numericTrustProxy = Number(env.trustProxy);
    app.set(
      "trust proxy",
      env.trustProxy === "true"
        ? true
        : Number.isInteger(numericTrustProxy)
          ? numericTrustProxy
          : env.trustProxy,
    );
  }

  // Content-Security-Policy defaults would block the app's Google Fonts stylesheet/font files,
  // which are same-origin-safe but hosted externally; the rest of Helmet's protections still apply.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(requestContext);
  // Image attachments ride along as base64 data URLs on the chat message body (no separate
  // upload endpoint yet) — base64 inflates size by ~33%, and up to MAX_ATTACHMENTS images can be
  // attached per message, so 2mb was rejecting any real photo outright with a bare 413 before it
  // ever reached chatService's own, more specific vision-support error.
  app.use(
    express.json({
      limit: "30mb",
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  morgan.token("request-id", (req) => (req as express.Request).requestId);
  app.use(morgan(':method :url :status :response-time ms request_id=:request-id'));

  app.use("/api/health", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/admin/providers", adminProvidersRouter);
  app.use("/api/admin/quota", adminQuotaRouter);
  app.use("/api/models", modelsRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/share", shareRouter);
  app.use("/api/push", pushRouter);
  app.use("/api/library", libraryRouter);
  app.use("/api/memory", memoryRouter);
  app.use("/api/automations", automationsRouter);
  app.use("/api/mcp", mcpRouter);
  app.use("/api/build", buildRouter);
  app.use("/api/voice", voiceRouter);
  app.use("/api/sandbox", sandboxRouter);
  app.use("/api/usage", usageRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/billing", billingRouter);
  app.use("/api/connectors", connectorsRouter);
  app.use("/api/organizations", organizationsRouter);
  app.use("/api/app", appRouter);

  if (existsSync(frontendDist)) {
    const indexPath = path.join(frontendDist, "index.html");
    const indexTemplate = readFileSync(indexPath, "utf8");
    const builtAt = statSync(indexPath).mtime;
    app.get("/robots.txt", (req, res) => {
      res.type("text/plain").send(robotsTxt(req.hostname));
    });
    app.get("/sitemap.xml", (_req, res) => {
      res.type("application/xml").send(sitemapXml(builtAt));
    });
    // index: false so "/" also goes through renderIndexHtml instead of the untouched static file.
    app.use(express.static(frontendDist, { index: false }));
    app.get(/^\/(?!api\/).*/, (req, res) => {
      const page = renderIndexHtml(indexTemplate, req.path, req.hostname);
      res.status(page.status).type("html").setHeader("Cache-Control", "no-cache").send(page.html);
    });
  }

  app.use(errorHandler);
  return app;
}
