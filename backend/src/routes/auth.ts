import { Router } from "express";
import {
  adminLogin,
  googleSignIn,
  login,
  logout,
  me,
  refresh,
  resendOtp,
  signup,
  updateProfile,
  verifyOtp,
} from "../controllers/authController.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

authRouter.post("/signup", asyncHandler(signup));
authRouter.post("/login", asyncHandler(login));
authRouter.post("/admin-login", asyncHandler(adminLogin));
authRouter.post("/verify-otp", asyncHandler(verifyOtp));
authRouter.post("/resend-otp", asyncHandler(resendOtp));
authRouter.post("/refresh", asyncHandler(refresh));
authRouter.post("/logout", asyncHandler(logout));
authRouter.get("/me", requireAuth, asyncHandler(me));
authRouter.patch("/profile", requireAuth, asyncHandler(updateProfile));
authRouter.post("/google", asyncHandler(googleSignIn)); // locked, returns 501 for now
