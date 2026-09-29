import { Router } from "express";
import * as controller from "../controllers/libraryController.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errorHandler.js";

export const libraryRouter = Router();
libraryRouter.use(requireAuth);
libraryRouter.get("/", asyncHandler(controller.list));
libraryRouter.get("/uploads/:id", asyncHandler(controller.upload));
libraryRouter.get("/:id", asyncHandler(controller.get));
libraryRouter.delete("/:id", asyncHandler(controller.remove));
