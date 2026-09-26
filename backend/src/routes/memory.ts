import { Router } from "express";
import * as controller from "../controllers/memoryController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";

export const memoryRouter = Router();
memoryRouter.use(requireAuth);
memoryRouter.get("/", asyncHandler(controller.list));
memoryRouter.post("/", asyncHandler(controller.create));
memoryRouter.delete("/", asyncHandler(controller.clear));
memoryRouter.delete("/:id", asyncHandler(controller.remove));
