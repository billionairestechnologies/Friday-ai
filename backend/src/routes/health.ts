import { Router, type Request, type Response } from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { isShuttingDown } from "../services/lifecycle.js";
import { redisConfigured, redisPing } from "../services/redisClient.js";

export const healthRouter = Router();

healthRouter.get("/live", (_req, res) => {
  res.json({
    status: "ok",
    service: "friday-ai-backend",
    time: new Date().toISOString(),
  });
});

async function readiness(_req: Request, res: Response) {
  if (isShuttingDown()) {
    res.status(503).json({ status: "unavailable", reason: "shutting_down" });
    return;
  }

  try {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Database readiness check timed out")), 3_000);
    });
    const result = await Promise.race([
      supabaseAdmin.from("providers").select("id", { count: "exact", head: true }),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (result.error) throw result.error;

    const redis = await redisPing();
    const redisRequired = redisConfigured();
    if (redisRequired && redis !== "ok") {
      res.status(503).json({
        status: "unavailable",
        service: "friday-ai-backend",
        dependencies: { database: "ok", redis },
        time: new Date().toISOString(),
      });
      return;
    }

    res.json({
      status: "ready",
      service: "friday-ai-backend",
      dependencies: { database: "ok", redis },
      time: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: "unavailable",
      service: "friday-ai-backend",
      dependencies: { database: "unavailable", redis: await redisPing() },
      time: new Date().toISOString(),
    });
  }
}

healthRouter.get("/", asyncHandler(readiness));
healthRouter.get("/ready", asyncHandler(readiness));
