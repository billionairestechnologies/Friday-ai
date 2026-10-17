import { Router } from "express";
import * as c from "../controllers/sessionsController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";

/** /api/sessions — the signed-in person's devices: web, phones and FridayX (supabase 0068). */
export const sessionsRouter = Router();
sessionsRouter.use(requireAuth);
sessionsRouter.get("/", asyncHandler(c.listMine));
sessionsRouter.post("/revoke-others", asyncHandler(c.revokeMyOthers));
sessionsRouter.delete("/:sessionId", asyncHandler(c.revokeMine));
