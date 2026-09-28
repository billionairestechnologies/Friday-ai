import { MESSAGE_COLUMNS } from "../services/chat/conversations.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../config/supabase.js";
import { supabasePublic } from "../config/supabasePublic.js";
import { HttpError } from "../middleware/errorHandler.js";
import { sendOtpEmail } from "../services/emailService.js";
import type { Session } from "@supabase/supabase-js";
import {
  decryptPendingSession,
  encryptPendingSession,
  generateOtp,
  hashOtp,
  verifyOtpHash,
} from "../utils/authSecurity.js";
import { env } from "../config/env.js";
import {
  buildGoogleLoginUrl,
  completeGoogleLogin,
  googleLoginConfigured,
  parseGoogleLoginState,
} from "../services/googleAuth.js";
import { buildGithubLoginUrl, completeGithubLogin, githubLoginConfigured } from "../services/githubAuth.js";
import { acceptPolicy, POLICY_VERSION, type Platform } from "../services/policyService.js";

const platformSchema = z.enum(["web", "android", "ios"]).default("web");

const signupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().trim().email().toLowerCase(),
  phone: z.string().trim().min(7, "Enter a valid mobile number").max(20),
  birthday: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  // The signup form's own required checkbox — the request is rejected outright (not just
  // ignored) if it's missing or false, so there's no way to create an account without agreeing.
  acceptedTerms: z.boolean().refine((v) => v === true, "You must agree to the Terms of Service and Privacy Policy"),
  platform: platformSchema,
});

const loginSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(1),
});

async function getProfileExtras(
  userId: string,
): Promise<{ role: "user" | "admin"; phone: string | null; birthday: string | null; policyVersion: string | null }> {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("role, phone, birthday, policy_version")
    .eq("id", userId)
    .single();
  return {
    role: data?.role === "admin" ? "admin" : "user",
    phone: data?.phone ?? null,
    birthday: data?.birthday ?? null,
    policyVersion: data?.policy_version ?? null,
  };
}

/** Verifies admin credentials and requires the same email OTP as every other privileged login. */
export async function adminLogin(req: Request, res: Response) {
  const { email, password } = loginSchema.parse(req.body);

  const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new HttpError(401, "Invalid email or password");

  const { role } = await getProfileExtras(data.user.id);
  if (role !== "admin") throw new HttpError(403, "This account doesn't have admin access");

  const name = (data.user.user_metadata?.full_name as string | undefined) ?? "admin";
  await issueOtp(email, name, data.session);
  res.json({ otpRequired: true, email });
}

/**
 * Creates the account pre-confirmed (via the service-role admin API, bypassing Supabase's own
 * email-confirmation-link flow entirely) then sends it through the same OTP step as login() —
 * signup and login share one verification UX instead of a link-based flow for one and a code
 * for the other.
 */
export async function signup(req: Request, res: Response) {
  const { name, email, phone, birthday, password, platform } = signupSchema.parse(req.body);

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name, phone, birthday },
  });

  if (error || !data.user) {
    const message = error?.message.includes("already been registered")
      ? "An account with that email already exists"
      : (error?.message ?? "Couldn't create that account");
    throw new HttpError(400, message);
  }

  // The handle_new_user trigger only sets full_name/phone from raw_user_meta_data (it predates
  // birthday) — set it directly rather than touching that trigger for one more column.
  await supabaseAdmin.from("profiles").update({ birthday }).eq("id", data.user.id);
  // acceptedTerms already passed schema validation (must be true) — the signup form's own
  // checkbox IS the consent, recorded the moment the account exists.
  await acceptPolicy(data.user.id, platform);

  const { data: signInData, error: signInError } = await supabasePublic.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !signInData.session) {
    throw new HttpError(500, "Account created but sign-in failed — try logging in");
  }

  await issueOtp(email, name, signInData.session);

  res.status(201).json({ otpRequired: true, email });
}

const updateProfileSchema = z.object({
  phone: z.string().trim().min(7, "Enter a valid mobile number").max(20).optional(),
  // Optional — collected from Settings → Account, powers the birthday greeting and age-banded
  // thinking lines. Nothing breaks if it's never set.
  birthday: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional(),
});

/** Lets a signed-in user fill in optional profile fields — phone (required by the "complete your
 *  profile" prompt shown for older accounts) and birthday (fully optional, from Settings). */
export async function updateProfile(req: Request, res: Response) {
  const { phone, birthday } = updateProfileSchema.parse(req.body);
  if (phone === undefined && birthday === undefined) throw new HttpError(400, "Nothing to update");

  const patch: { phone?: string; birthday?: string } = {};
  if (phone !== undefined) patch.phone = phone;
  if (birthday !== undefined) patch.birthday = birthday;

  const { error } = await supabaseAdmin.from("profiles").update(patch).eq("id", req.user!.id);
  if (error) throw new HttpError(500, "Failed to update profile");

  res.json({ user: { ...req.user!, ...patch } });
}

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

/** Stores only a keyed OTP hash and encrypted pending session until the code is confirmed. */
async function issueOtp(email: string, name: string, session: Session) {
  const code = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();

  await supabaseAdmin.from("login_otps").delete().eq("email", email);
  const { error } = await supabaseAdmin
    .from("login_otps")
    .insert({
      email,
      code_hash: hashOtp(email, code),
      session_ciphertext: encryptPendingSession(session),
      expires_at: expiresAt,
    });
  if (error) throw new HttpError(500, "Failed to start sign-in");

  await sendOtpEmail(email, name, code);
}

export async function login(req: Request, res: Response) {
  const { email, password } = loginSchema.parse(req.body);

  const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new HttpError(401, "Invalid email or password");

  const name = (data.user.user_metadata?.full_name as string | undefined) ?? "there";
  await issueOtp(email, name, data.session);

  res.json({ otpRequired: true, email });
}

const verifyOtpSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  code: z.string().trim().length(6),
});

export async function verifyOtp(req: Request, res: Response) {
  const { email, code } = verifyOtpSchema.parse(req.body);

  const { data: row, error } = await supabaseAdmin
    .from("login_otps")
    .select("*")
    .eq("email", email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !row) throw new HttpError(400, "No pending sign-in for this email — log in again");

  if (new Date(row.expires_at as string).getTime() < Date.now()) {
    await supabaseAdmin.from("login_otps").delete().eq("id", row.id as string);
    throw new HttpError(400, "That code expired — request a new one");
  }
  if ((row.attempts as number) >= OTP_MAX_ATTEMPTS) {
    await supabaseAdmin.from("login_otps").delete().eq("id", row.id as string);
    throw new HttpError(429, "Too many attempts — request a new code");
  }
  if (!verifyOtpHash(email, code, row.code_hash as string)) {
    await supabaseAdmin
      .from("login_otps")
      .update({ attempts: (row.attempts as number) + 1 })
      .eq("id", row.id as string);
    throw new HttpError(400, "Incorrect code");
  }

  await supabaseAdmin.from("login_otps").delete().eq("id", row.id as string);

  let session: Session;
  try {
    session = decryptPendingSession<Session>(row.session_ciphertext as string);
  } catch {
    throw new HttpError(400, "That sign-in expired or is invalid. Please log in again.");
  }
  const { role, phone, birthday, policyVersion } = await getProfileExtras(session.user.id);
  res.json({
    user: {
      id: session.user.id,
      email: session.user.email,
      name: (session.user.user_metadata?.full_name as string | undefined) ?? null,
      phone,
      birthday,
      role,
      policyVersion,
    },
    session,
  });
}

const resendOtpSchema = z.object({ email: z.string().trim().email().toLowerCase() });

export async function resendOtp(req: Request, res: Response) {
  const { email } = resendOtpSchema.parse(req.body);

  const { data: row, error } = await supabaseAdmin
    .from("login_otps")
    .select("*")
    .eq("email", email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !row) throw new HttpError(400, "No pending sign-in for this email — log in again");

  let session: Session;
  try {
    session = decryptPendingSession<Session>(row.session_ciphertext as string);
  } catch {
    await supabaseAdmin.from("login_otps").delete().eq("id", row.id as string);
    throw new HttpError(400, "That sign-in expired or is invalid. Please log in again.");
  }
  const name = (session.user.user_metadata?.full_name as string | undefined) ?? "there";
  await issueOtp(email, name, session);

  res.json({ otpRequired: true, email });
}

const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const passwordResetSchema = z.object({ email: z.string().trim().email().toLowerCase() });

/** Exchanges a refresh token for a new access token — the session's access token is a short-lived
 *  JWT (~1hr), so long-running tabs need this instead of forcing a re-login every hour. */
export async function refresh(req: Request, res: Response) {
  const { refreshToken } = refreshSchema.parse(req.body);

  const { data, error } = await supabasePublic.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session || !data.user) throw new HttpError(401, "Session expired — please sign in again");

  const { role, phone, birthday, policyVersion } = await getProfileExtras(data.user.id);
  res.json({
    user: {
      id: data.user.id,
      email: data.user.email,
      name: (data.user.user_metadata?.full_name as string | undefined) ?? null,
      phone,
      birthday,
      role,
      policyVersion,
    },
    session: data.session,
  });
}

export async function requestPasswordReset(req: Request, res: Response) {
  const { email } = passwordResetSchema.parse(req.body);
  await supabasePublic.auth.resetPasswordForEmail(email, {
    redirectTo: `${req.protocol}://${req.get("host") ?? ""}/`,
  });
  res.json({ ok: true });
}

export async function logout(_req: Request, res: Response) {
  // Sessions are stateless JWTs on the client; logout is just discarding the token there.
  res.status(204).send();
}

export async function me(req: Request, res: Response) {
  res.json({ user: req.user });
}

const acceptPolicySchema = z.object({ platform: platformSchema });

/** The blocking "I agree" gate (shown to any signed-in account whose policyVersion is behind
 *  POLICY_VERSION) calls this on the button tap, on web, Android and iOS alike. */
export async function acceptPolicyRoute(req: Request, res: Response) {
  const { platform } = acceptPolicySchema.parse(req.body);
  const result = await acceptPolicy(req.user!.id, platform);
  res.json({ user: { ...req.user!, policyVersion: result.policyVersion } });
}

export async function policyStatus(_req: Request, res: Response) {
  res.json({ policyVersion: POLICY_VERSION });
}

export async function exportAccount(req: Request, res: Response) {
  const userId = req.user!.id;
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, phone, birthday, role, created_at")
    .eq("id", userId)
    .single();
  if (profileError) throw new HttpError(500, profileError.message);

  const { data: conversations, error: conversationsError } = await supabaseAdmin
    .from("conversations")
    .select(`*, providers(slug, display_name), messages(${MESSAGE_COLUMNS}, message_attachments(*))`)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (conversationsError) throw new HttpError(500, conversationsError.message);

  res.json({
    exportedAt: new Date().toISOString(),
    user: req.user,
    profile,
    conversations: conversations ?? [],
  });
}

export async function deleteAccount(req: Request, res: Response) {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user!.id);
  if (error) throw new HttpError(500, error.message);
  res.status(204).send();
}

/** Google sign-in is started at GET /auth/google/start and completed by the callback. */
export async function startGoogleLogin(req: Request, res: Response) {
  const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/";
  res.json({ url: buildGoogleLoginUrl(returnTo), enabled: googleLoginConfigured() });
}

export async function googleCallback(req: Request, res: Response) {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code || !state) throw new HttpError(400, "Missing Google sign-in code or state");

  const { returnTo } = parseGoogleLoginState(state);
  const completed = await completeGoogleLogin(code);
  const { role, phone, birthday, policyVersion } = await getProfileExtras(completed.user.id);
  const payload = Buffer.from(
    JSON.stringify({
      session: {
        access_token: completed.session.access_token,
        refresh_token: completed.session.refresh_token,
      },
      user: {
        id: completed.user.id,
        email: completed.user.email,
        name: completed.name,
        phone,
        birthday,
        role,
        policyVersion,
      },
    }),
    "utf8",
  ).toString("base64url");

  const target = new URL(returnTo, env.publicAppUrl);
  target.hash = `friday_session=${payload}`;
  res.redirect(target.toString());
}

export async function googleSignIn(_req: Request, res: Response) {
  throw new HttpError(405, "Use GET /api/auth/google/start");
}

/** GitHub sign-in is started here but completed by connectorsRouter's /github/callback,
 *  since a classic GitHub OAuth App only supports one registered callback URL — the one
 *  already used for the repo-connector flow. That handler branches on state.purpose. */
export async function startGithubLogin(req: Request, res: Response) {
  const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/";
  res.json({ url: buildGithubLoginUrl(returnTo), enabled: githubLoginConfigured() });
}

export async function finishGithubLoginRedirect(code: string, returnTo: string): Promise<string> {
  const completed = await completeGithubLogin(code);
  const { role, phone, birthday, policyVersion } = await getProfileExtras(completed.user.id);
  const payload = Buffer.from(
    JSON.stringify({
      session: {
        access_token: completed.session.access_token,
        refresh_token: completed.session.refresh_token,
      },
      user: {
        id: completed.user.id,
        email: completed.user.email,
        name: completed.name,
        phone,
        birthday,
        role,
        policyVersion,
      },
    }),
    "utf8",
  ).toString("base64url");

  const target = new URL(returnTo, env.publicAppUrl);
  target.hash = `friday_session=${payload}`;
  return target.toString();
}
