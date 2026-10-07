import { randomBytes } from "node:crypto";
import { safeReturnTo } from "../utils/safeReturnTo.js";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import { supabasePublic } from "../config/supabasePublic.js";
import { HttpError } from "../middleware/errorHandler.js";
import { acceptPolicy } from "./policyService.js";

const GOOGLE_LOGIN_SCOPES = ["openid", "email", "profile"];

export function googleLoginConfigured(): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret);
}

export function buildGoogleLoginUrl(returnTo?: string | null): string {
  if (!googleLoginConfigured()) {
    throw new HttpError(503, "Google sign-in is not configured yet");
  }
  const state = Buffer.from(
    JSON.stringify({
      purpose: "login",
      nonce: randomBytes(16).toString("hex"),
      returnTo: safeReturnTo(returnTo),
    }),
    "utf8",
  ).toString("base64url");

  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: env.googleLoginRedirectUri,
    response_type: "code",
    scope: GOOGLE_LOGIN_SCOPES.join(" "),
    include_granted_scopes: "true",
    prompt: "select_account",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function parseGoogleLoginState(state: string): { returnTo: string } {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
      purpose?: unknown;
      returnTo?: unknown;
    };
    if (parsed.purpose !== "login") throw new Error("wrong purpose");
    return { returnTo: safeReturnTo(parsed.returnTo) };
  } catch {
    throw new HttpError(400, "Invalid Google sign-in state");
  }
}

export async function completeGoogleLogin(code: string) {
  if (!googleLoginConfigured()) {
    throw new HttpError(503, "Google sign-in is not configured yet");
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: env.googleLoginRedirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokenBody = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw new HttpError(502, tokenBody.error_description || tokenBody.error || "Google sign-in token exchange failed");
  }

  const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` },
  });
  const profile = (await profileResponse.json()) as {
    id?: string;
    email?: string;
    name?: string;
    error?: { message?: string };
  };
  if (!profileResponse.ok || !profile.email || !profile.id) {
    throw new HttpError(502, profile.error?.message || "Google did not return an email for this account");
  }

  const email = profile.email.toLowerCase();
  const name = profile.name || email.split("@")[0];

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: name, google_id: profile.id, auth_provider: "google" },
  });
  if (createError && !/already|registered|exists/i.test(createError.message)) {
    throw new HttpError(500, createError.message);
  }
  // A brand-new account has no signup form of its own to check a Terms/Privacy box on — this
  // stands in for it (same as the checkbox does for the password flow's signup()), rather than
  // leaving the account to hit the blocking "I Agree" gate on its very first visit. An existing
  // account signing back in via Google keeps whatever acceptance status it already has (still
  // re-gated normally if it's behind on a later policy version, same as any other account).
  if (!createError && created?.user) await acceptPolicy(created.user.id, "web");

  const { data: link, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const hashedToken = link?.properties?.hashed_token;
  if (linkError || !hashedToken) {
    throw new HttpError(500, linkError?.message ?? "Couldn't start a Google session");
  }

  const { data: verified, error: verifyError } = await supabasePublic.auth.verifyOtp({
    token_hash: hashedToken,
    type: "email",
  });
  if (verifyError || !verified.session || !verified.user) {
    throw new HttpError(500, verifyError?.message ?? "Couldn't complete Google sign-in");
  }

  await supabaseAdmin.from("profiles").update({ full_name: name }).eq("id", verified.user.id);

  return {
    session: verified.session,
    user: verified.user,
    email,
    name,
  };
}
