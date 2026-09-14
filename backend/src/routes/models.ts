import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler.js";
import * as providerService from "../services/providerService.js";

export const modelsRouter = Router();

// Powers the model selector shown on both the auth page (pre-login) and the chat page,
// so it's intentionally public — it only exposes model names, never API keys.
modelsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ models: await providerService.listModelsForUsers() });
  }),
);
