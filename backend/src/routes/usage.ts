import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { usageSummary } from "../services/usageService.js";

export const usageRouter = Router();

usageRouter.use(requireAuth);

usageRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    res.json(await usageSummary(req.user!.id));
  }),
);
