import { randomBytes } from "node:crypto";
import { safeReturnTo } from "../utils/safeReturnTo.js";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import { supabasePublic } from "../config/supabasePublic.js";
import { HttpError } from "../middleware/errorHandler.js";
import { acceptPolicy } from "./policyService.js";

const GITHUB_LOGIN_SCOPES = ["read:user", "user:email"];

export function githubLoginConfigured(): boolean {
  return Boolean(env.githubClientId && env.githubClientSecret);
}

export function buildGithubLoginUrl(returnTo?: string | null): string {
  if (!githubLoginConfigured()) {
    throw new HttpError(503, "GitHub sign-in is not configured yet");
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
    client_id: env.githubClientId,
    redirect_uri: env.githubRedirectUri,
    scope: GITHUB_LOGIN_SCOPES.join(" "),
    state,
    allow_signup: "true",
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export function isGithubLoginState(state: string): boolean {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
      purpose?: unknown;
    };
    return parsed.purpose === "login";
  } catch {
    return false;
  }
}

export function parseGithubLoginState(state: string): { returnTo: string } {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
      purpose?: unknown;
      returnTo?: unknown;
    };
    if (parsed.purpose !== "login") throw new Error("wrong purpose");
    return { returnTo: safeReturnTo(parsed.returnTo) };
  } catch {
    throw new HttpError(400, "Invalid GitHub sign-in state");
  }
}

export async function completeGithubLogin(code: string) {
  if (!githubLoginConfigured()) {
    throw new HttpError(503, "GitHub sign-in is not configured yet");
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: env.githubClientId,
      client_secret: env.githubClientSecret,
      redirect_uri: env.githubRedirectUri,
    }),
  });
  const tokenBody = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw new HttpError(502, tokenBody.error_description || tokenBody.error || "GitHub sign-in token exchange failed");
  }

  const headers = {
    Authorization: `Bearer ${tokenBody.access_token}`,
    Accept: "application/vnd.github+json",
  };
  const profileResponse = await fetch("https://api.github.com/user", { headers });
  const profile = (await profileResponse.json()) as {
    id?: number;
    login?: string;
    name?: string | null;
    email?: string | null;
    message?: string;
  };
  if (!profileResponse.ok || !profile.id) {
    throw new HttpError(502, profile.message || "GitHub did not return a profile for this account");
  }

  let email = profile.email?.toLowerCase() || null;
  if (!email) {
    const emailsResponse = await fetch("https://api.github.com/user/emails", { headers });
    if (emailsResponse.ok) {
      const emails = (await emailsResponse.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      email = primary?.email.toLowerCase() ?? null;
    }
  }
  if (!email) {
    throw new HttpError(
      400,
      "Your GitHub account has no verified email available. Add/verify one at github.com/settings/emails and try again.",
    );
  }

  const name = profile.name || profile.login || email.split("@")[0];

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: name, github_id: profile.id, github_login: profile.login, auth_provider: "github" },
  });
  if (createError && !/already|registered|exists/i.test(createError.message)) {
    throw new HttpError(500, createError.message);
  }
  // Same reasoning as googleAuth.ts's completeGoogleLogin: a brand-new account here never saw the
  // signup form's own Terms/Privacy checkbox, so this stands in for it instead of landing the
  // account straight on the blocking "I Agree" gate on its first visit.
  if (!createError && created?.user) await acceptPolicy(created.user.id, "web");

  const { data: link, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const hashedToken = link?.properties?.hashed_token;
  if (linkError || !hashedToken) {
    throw new HttpError(500, linkError?.message ?? "Couldn't start a GitHub session");
  }

  const { data: verified, error: verifyError } = await supabasePublic.auth.verifyOtp({
    token_hash: hashedToken,
    type: "email",
  });
  if (verifyError || !verified.session || !verified.user) {
    throw new HttpError(500, verifyError?.message ?? "Couldn't complete GitHub sign-in");
  }

  await supabaseAdmin.from("profiles").update({ full_name: name }).eq("id", verified.user.id);

  return {
    session: verified.session,
    user: verified.user,
    email,
    name,
  };
}
