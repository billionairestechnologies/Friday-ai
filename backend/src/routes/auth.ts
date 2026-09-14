import { Router } from "express";
import { googleSignIn, login, logout, me, signup } from "../controllers/authController.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

authRouter.post("/signup", asyncHandler(signup));
authRouter.post("/login", asyncHandler(login));
authRouter.post("/logout", asyncHandler(logout));
authRouter.get("/me", requireAuth, asyncHandler(me));
authRouter.post("/google", asyncHandler(googleSignIn)); // locked, returns 501 for now
