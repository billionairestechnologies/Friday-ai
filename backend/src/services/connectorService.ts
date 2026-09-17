import { createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { decryptSecret, encryptSecret } from "../utils/crypto.js";
import { recordAdminAuditLog } from "./usageService.js";

export type ConnectorProvider = "github";

export type ConnectorAccountPublic = {
  id: string;
  provider: ConnectorProvider;
  accountLogin: string | null;
  accountName: string | null;
  scopes: string[];
  connectedAt: string;
  configured: boolean;
};

function requireGitHubOAuth() {
  if (!env.githubClientId || !env.githubClientSecret) {
    throw new HttpError(503, "GitHub connector is not configured yet");
  }
}

export function connectorConfig() {
  return {
    github: {
      configured: Boolean(env.githubClientId && env.githubClientSecret),
      scopes: ["read:user", "repo"],
    },
  };
}

export async function listConnectorAccounts(userId: string): Promise<ConnectorAccountPublic[]> {
  const { data, error } = await supabaseAdmin
    .from("connector_accounts")
    .select("id, provider, account_login, account_name, scopes, connected_at")
    .eq("user_id", userId)
    .order("connected_at", { ascending: false });
  if (error) throw new HttpError(500, error.message);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    provider: row.provider as ConnectorProvider,
    accountLogin: (row.account_login as string | null) ?? null,
    accountName: (row.account_name as string | null) ?? null,
    scopes: (row.scopes as string[] | null) ?? [],
    connectedAt: row.connected_at as string,
    configured: true,
  }));
}

export function buildGitHubAuthorizeUrl(userId: string, returnTo?: string | null) {
  requireGitHubOAuth();
  const statePayload = Buffer.from(
    JSON.stringify({
      userId,
      nonce: randomBytes(16).toString("hex"),
      returnTo: returnTo || "/?dialog=plugins",
    }),
    "utf8",
  ).toString("base64url");

  const params = new URLSearchParams({
    client_id: env.githubClientId,
    redirect_uri: env.githubRedirectUri,
    scope: "read:user repo",
    state: statePayload,
    allow_signup: "true",
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export function parseOAuthState(state: string): { userId: string; returnTo: string } {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
      userId?: unknown;
      returnTo?: unknown;
    };
    if (typeof parsed.userId !== "string" || !parsed.userId) {
      throw new Error("missing user");
    }
    return {
      userId: parsed.userId,
      returnTo: typeof parsed.returnTo === "string" ? parsed.returnTo : "/?dialog=plugins",
    };
  } catch {
    throw new HttpError(400, "Invalid OAuth state");
  }
}

export async function completeGitHubOAuth(userId: string, code: string) {
  requireGitHubOAuth();

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.githubClientId,
      client_secret: env.githubClientSecret,
      code,
      redirect_uri: env.githubRedirectUri,
    }),
  });
  const tokenBody = (await tokenResponse.json()) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw new HttpError(502, tokenBody.error_description || tokenBody.error || "GitHub token exchange failed");
  }

  const profileResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Friday-AI",
    },
  });
  const profile = (await profileResponse.json()) as {
    id?: number;
    login?: string;
    name?: string | null;
    message?: string;
  };
  if (!profileResponse.ok || !profile.id || !profile.login) {
    throw new HttpError(502, profile.message || "Failed to load GitHub profile");
  }

  const scopes = (tokenBody.scope ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);

  const { data, error } = await supabaseAdmin
    .from("connector_accounts")
    .upsert(
      {
        user_id: userId,
        provider: "github",
        external_account_id: String(profile.id),
        account_login: profile.login,
        account_name: profile.name ?? profile.login,
        access_token_encrypted: encryptSecret(tokenBody.access_token),
        refresh_token_encrypted: null,
        scopes,
        metadata: { github_id: profile.id },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider" },
    )
    .select("id, provider, account_login, account_name, scopes, connected_at")
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to save connector");

  await recordAdminAuditLog(userId, "connector.connect", "connector", data.id as string, {
    provider: "github",
    login: profile.login,
  });

  return {
    id: data.id as string,
    provider: "github" as const,
    accountLogin: (data.account_login as string | null) ?? null,
    accountName: (data.account_name as string | null) ?? null,
    scopes: (data.scopes as string[] | null) ?? [],
    connectedAt: data.connected_at as string,
    configured: true,
  };
}

export async function disconnectConnector(userId: string, provider: ConnectorProvider) {
  const { data, error } = await supabaseAdmin
    .from("connector_accounts")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider)
    .select("id")
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (data?.id) {
    await recordAdminAuditLog(userId, "connector.disconnect", "connector", data.id as string, { provider });
  }
}

export async function getGitHubAccessToken(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("connector_accounts")
    .select("access_token_encrypted")
    .eq("user_id", userId)
    .eq("provider", "github")
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data?.access_token_encrypted) return null;
  return decryptSecret(data.access_token_encrypted as string);
}

export async function searchGitHubRepositories(userId: string, query: string) {
  const token = await getGitHubAccessToken(userId);
  if (!token) throw new HttpError(400, "Connect GitHub before searching repositories");

  const url = query.trim()
    ? `https://api.github.com/search/repositories?q=${encodeURIComponent(`${query} in:name`)}&per_page=8`
    : "https://api.github.com/user/repos?sort=updated&per_page=8";

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Friday-AI",
    },
  });
  const body = (await response.json()) as
    | { items?: Array<{ full_name: string; html_url: string; description: string | null }>; message?: string }
    | Array<{ full_name: string; html_url: string; description: string | null }>;

  if (!response.ok) {
    const message = !Array.isArray(body) && typeof body.message === "string" ? body.message : "GitHub request failed";
    throw new HttpError(502, message);
  }

  const repos = Array.isArray(body) ? body : body.items ?? [];
  return repos.map((repo) => ({
    fullName: repo.full_name,
    url: repo.html_url,
    description: repo.description,
  }));
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
