import { Router } from "express";
import * as c from "../controllers/statusController.js";
import { optionalAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { rateLimit } from "../middleware/rateLimit.js";

/** /api/status — public on purpose: the status page must work signed out, and during an outage. */
export const statusRouter = Router();
statusRouter.get("/", rateLimit({ name: "status-read", limit: 120, windowMs: 60_000 }), asyncHandler(c.publicStatus));
statusRouter.post("/report", rateLimit({ name: "status-report", limit: 5, windowMs: 60 * 60_000 }), optionalAuth, asyncHandler(c.report));
// A crash loop can fire many reports — the limit keeps one broken client from flooding the table.
statusRouter.post("/crash", rateLimit({ name: "status-crash", limit: 30, windowMs: 60 * 60_000 }), optionalAuth, asyncHandler(c.crash));
