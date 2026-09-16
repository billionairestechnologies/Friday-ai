import type { Request, Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../config/supabase.js";
import { supabasePublic } from "../config/supabasePublic.js";
import { HttpError } from "../middleware/errorHandler.js";
import { sendOtpEmail } from "../services/emailService.js";
import type { Session } from "@supabase/supabase-js";

const signupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().trim().email(),
  phone: z.string().trim().min(7, "Enter a valid mobile number").max(20),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

async function getProfileExtras(userId: string): Promise<{ role: "user" | "admin"; phone: string | null }> {
  const { data } = await supabaseAdmin.from("profiles").select("role, phone").eq("id", userId).single();
  return { role: data?.role === "admin" ? "admin" : "user", phone: data?.phone ?? null };
}

/**
 * The hidden /admin gate skips the OTP step — it's a separate, rarely-used, already-locked-down
 * entry point (its own URL, its own username+password), and gating it behind the consumer OTP
 * flow would tie admin access to whichever inbox happens to be reachable through the configured
 * email sender. Still re-verifies the resulting user is actually an admin, so this endpoint can't
 * be used as a back door around OTP for a regular account.
 */
export async function adminLogin(req: Request, res: Response) {
  const { email, password } = loginSchema.parse(req.body);

  const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new HttpError(401, "Invalid email or password");

  const { role, phone } = await getProfileExtras(data.user.id);
  if (role !== "admin") throw new HttpError(403, "This account doesn't have admin access");

  res.json({
    user: {
      id: data.user.id,
      email: data.user.email,
      name: (data.user.user_metadata?.full_name as string | undefined) ?? null,
      phone,
      role,
    },
    session: data.session,
  });
}

/**
 * Creates the account pre-confirmed (via the service-role admin API, bypassing Supabase's own
 * email-confirmation-link flow entirely) then sends it through the same OTP step as login() —
 * signup and login share one verification UX instead of a link-based flow for one and a code
 * for the other.
 */
export async function signup(req: Request, res: Response) {
  const { name, email, phone, password } = signupSchema.parse(req.body);

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name, phone },
  });

  if (error || !data.user) {
    const message = error?.message.includes("already been registered")
      ? "An account with that email already exists"
      : (error?.message ?? "Couldn't create that account");
    throw new HttpError(400, message);
  }

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
  phone: z.string().trim().min(7, "Enter a valid mobile number").max(20),
});

/** Lets a signed-in user fill in profile fields collected after signup started requiring them
 *  (currently just phone) — the "complete your profile" prompt shown for older accounts. */
export async function updateProfile(req: Request, res: Response) {
  const { phone } = updateProfileSchema.parse(req.body);

  const { error } = await supabaseAdmin.from("profiles").update({ phone }).eq("id", req.user!.id);
  if (error) throw new HttpError(500, "Failed to update profile");

  res.json({ user: { ...req.user!, phone } });
}

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Stores the OTP (replacing any prior pending one for this email) and emails it. The Supabase
 *  session obtained from the password check rides along in the row until the code is confirmed. */
async function issueOtp(email: string, name: string, session: Session) {
  const code = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString();

  await supabaseAdmin.from("login_otps").delete().eq("email", email);
  const { error } = await supabaseAdmin
    .from("login_otps")
    .insert({ email, code, session, expires_at: expiresAt });
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
  email: z.string().trim().email(),
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
  if (row.code !== code) {
    await supabaseAdmin
      .from("login_otps")
      .update({ attempts: (row.attempts as number) + 1 })
      .eq("id", row.id as string);
    throw new HttpError(400, "Incorrect code");
  }

  await supabaseAdmin.from("login_otps").delete().eq("id", row.id as string);

  const session = row.session as Session;
  const { role, phone } = await getProfileExtras(session.user.id);
  res.json({
    user: {
      id: session.user.id,
      email: session.user.email,
      name: (session.user.user_metadata?.full_name as string | undefined) ?? null,
      phone,
      role,
    },
    session,
  });
}

const resendOtpSchema = z.object({ email: z.string().trim().email() });

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

  const session = row.session as Session;
  const name = (session.user.user_metadata?.full_name as string | undefined) ?? "there";
  await issueOtp(email, name, session);

  res.json({ otpRequired: true, email });
}

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

/** Exchanges a refresh token for a new access token — the session's access token is a short-lived
 *  JWT (~1hr), so long-running tabs need this instead of forcing a re-login every hour. */
export async function refresh(req: Request, res: Response) {
  const { refreshToken } = refreshSchema.parse(req.body);

  const { data, error } = await supabasePublic.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session || !data.user) throw new HttpError(401, "Session expired — please sign in again");

  const { role, phone } = await getProfileExtras(data.user.id);
  res.json({
    user: {
      id: data.user.id,
      email: data.user.email,
      name: (data.user.user_metadata?.full_name as string | undefined) ?? null,
      phone,
      role,
    },
    session: data.session,
  });
}

export async function logout(_req: Request, res: Response) {
  // Sessions are stateless JWTs on the client; logout is just discarding the token there.
  res.status(204).send();
}

export async function me(req: Request, res: Response) {
  res.json({ user: req.user });
}

/** Google sign-in is wired for later — kept locked/disabled on the frontend for now. */
export async function googleSignIn(_req: Request, res: Response) {
  throw new HttpError(501, "Google sign-in is coming soon");
}
