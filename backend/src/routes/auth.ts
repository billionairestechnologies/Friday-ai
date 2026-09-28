import { Router } from "express";
import {
  acceptPolicyRoute,
  adminLogin,
  deleteAccount,
  exportAccount,
  googleCallback,
  googleSignIn,
  login,
  logout,
  me,
  policyStatus,
  refresh,
  requestPasswordReset,
  resendOtp,
  signup,
  startGithubLogin,
  startGoogleLogin,
  updateProfile,
  verifyOtp,
} from "../controllers/authController.js";
import { googleLoginConfigured } from "../services/googleAuth.js";
import { githubLoginConfigured } from "../services/githubAuth.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { credentialKey, rateLimit } from "../middleware/rateLimit.js";

export const authRouter = Router();

const credentialLimit = rateLimit({
  name: "auth-credential",
  limit: env.rateLimits.authPer15Minutes,
  windowMs: 15 * 60_000,
  key: credentialKey,
});
const otpLimit = rateLimit({
  name: "auth-otp",
  limit: env.rateLimits.otpPer10Minutes,
  windowMs: 10 * 60_000,
  key: credentialKey,
});
const refreshLimit = rateLimit({
  name: "auth-refresh",
  limit: 60,
  windowMs: 15 * 60_000,
});

authRouter.post("/signup", credentialLimit, asyncHandler(signup));
authRouter.post("/login", credentialLimit, asyncHandler(login));
authRouter.post("/admin-login", credentialLimit, asyncHandler(adminLogin));
authRouter.post("/verify-otp", otpLimit, asyncHandler(verifyOtp));
authRouter.post("/resend-otp", otpLimit, asyncHandler(resendOtp));
authRouter.post("/refresh", refreshLimit, asyncHandler(refresh));
authRouter.post("/password-reset", credentialLimit, asyncHandler(requestPasswordReset));
authRouter.post("/logout", asyncHandler(logout));
authRouter.get("/me", requireAuth, asyncHandler(me));
authRouter.get("/policy", asyncHandler(policyStatus));
authRouter.post("/accept-policy", requireAuth, asyncHandler(acceptPolicyRoute));
authRouter.get("/export", requireAuth, asyncHandler(exportAccount));
authRouter.delete("/account", requireAuth, asyncHandler(deleteAccount));
authRouter.patch("/profile", requireAuth, asyncHandler(updateProfile));
authRouter.post("/google", asyncHandler(googleSignIn));
authRouter.get("/google/start", credentialLimit, asyncHandler(startGoogleLogin));
authRouter.get("/google/callback", asyncHandler(googleCallback));
authRouter.get("/github/start", credentialLimit, asyncHandler(startGithubLogin));
authRouter.get(
  "/sso",
  asyncHandler(async (_req, res) => {
    res.json({
      enabled: env.ssoEnabled,
      entryUrl: env.ssoEnabled ? env.ssoEntryUrl || null : null,
      providerLabel: env.ssoProviderLabel,
      google: googleLoginConfigured(),
      github: githubLoginConfigured(),
    });
  }),
);
