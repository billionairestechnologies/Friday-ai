import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { decryptSecret, encryptSecret } from "../utils/crypto.js";
import { recordAdminAuditLog } from "./usageService.js";
import {
  isTokenConnector,
  TOKEN_CONNECTORS,
  type TokenConnectorId,
} from "./tokenConnectors.js";

export type ConnectorProvider =
  | "github"
  | "google"
  | TokenConnectorId;

export type ConnectorAccountPublic = {
  id: string;
  provider: ConnectorProvider;
  accountLogin: string | null;
  accountName: string | null;
  scopes: string[];
  connectedAt: string;
  configured: boolean;
};

const GOOGLE_CONNECTOR_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
];

function requireGitHubOAuth() {
  if (!env.githubClientId || !env.githubClientSecret) {
    throw new HttpError(503, "GitHub connector is not configured yet");
  }
}

function requireGoogleOAuth() {
  if (!env.googleClientId || !env.googleClientSecret) {
    throw new HttpError(503, "Google connector is not configured yet");
  }
}

export function connectorConfig() {
  return {
    github: {
      mode: "oauth" as const,
      configured: Boolean(env.githubClientId && env.githubClientSecret),
      pluginIds: ["github"],
      fields: [] as const,
      scopes: ["read:user", "repo"],
    },
    google: {
      mode: "oauth" as const,
      configured: Boolean(env.googleClientId && env.googleClientSecret),
      pluginIds: ["calendar", "gmail", "drive"],
      fields: [] as const,
      scopes: GOOGLE_CONNECTOR_SCOPES,
    },
    ...Object.fromEntries(
      Object.entries(TOKEN_CONNECTORS).map(([provider, spec]) => [
        provider,
        {
          mode: "token" as const,
          configured: true,
          pluginIds: spec.pluginIds,
          fields: spec.fields,
        },
      ]),
    ),
  };
}

export const CONNECTOR_PROVIDERS = [
  "github",
  "google",
  ...Object.keys(TOKEN_CONNECTORS),
] as const;

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
      provider: "github",
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

export function buildGoogleAuthorizeUrl(userId: string, returnTo?: string | null) {
  requireGoogleOAuth();
  const statePayload = Buffer.from(
    JSON.stringify({
      userId,
      provider: "google",
      nonce: randomBytes(16).toString("hex"),
      returnTo: returnTo || "/?dialog=plugins",
    }),
    "utf8",
  ).toString("base64url");

  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: env.googleConnectorRedirectUri,
    response_type: "code",
    scope: GOOGLE_CONNECTOR_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state: statePayload,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function parseOAuthState(state: string): { userId: string; returnTo: string; provider?: ConnectorProvider } {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
      userId?: unknown;
      returnTo?: unknown;
      provider?: unknown;
    };
    if (typeof parsed.userId !== "string" || !parsed.userId) {
      throw new Error("missing user");
    }
    return {
      userId: parsed.userId,
      returnTo: typeof parsed.returnTo === "string" ? parsed.returnTo : "/?dialog=plugins",
      provider:
        parsed.provider === "github" || parsed.provider === "google"
          ? parsed.provider
          : undefined,
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

export async function completeGoogleOAuth(userId: string, code: string) {
  requireGoogleOAuth();

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: env.googleConnectorRedirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokenBody = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw new HttpError(502, tokenBody.error_description || tokenBody.error || "Google token exchange failed");
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
  if (!profileResponse.ok || !profile.id) {
    throw new HttpError(502, profile.error?.message || "Failed to load Google profile");
  }

  const scopes = (tokenBody.scope ?? GOOGLE_CONNECTOR_SCOPES.join(" "))
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  const { data, error } = await supabaseAdmin
    .from("connector_accounts")
    .upsert(
      {
        user_id: userId,
        provider: "google",
        external_account_id: profile.id,
        account_login: profile.email ?? profile.id,
        account_name: profile.name ?? profile.email ?? profile.id,
        access_token_encrypted: encryptSecret(tokenBody.access_token),
        refresh_token_encrypted: tokenBody.refresh_token ? encryptSecret(tokenBody.refresh_token) : null,
        scopes,
        metadata: { google_id: profile.id, email: profile.email ?? null },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider" },
    )
    .select("id, provider, account_login, account_name, scopes, connected_at")
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to save connector");

  await recordAdminAuditLog(userId, "connector.connect", "connector", data.id as string, {
    provider: "google",
    email: profile.email ?? null,
  });

  return {
    id: data.id as string,
    provider: "google" as const,
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

export async function getGoogleAccessToken(userId: string): Promise<{ token: string; scopes: string[] } | null> {
  const { data, error } = await supabaseAdmin
    .from("connector_accounts")
    .select("access_token_encrypted, scopes")
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data?.access_token_encrypted) return null;
  return { token: decryptSecret(data.access_token_encrypted as string), scopes: (data.scopes as string[] | null) ?? [] };
}

/** Google access tokens live ~1 hour. Exchanges the stored refresh token for a new access token,
 *  saves it, and returns it — or null when there is no refresh token (the user must reconnect). */
export async function refreshGoogleAccessToken(userId: string): Promise<string | null> {
  if (!env.googleClientId || !env.googleClientSecret) return null;
  const { data } = await supabaseAdmin
    .from("connector_accounts")
    .select("refresh_token_encrypted")
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();
  if (!data?.refresh_token_encrypted) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      refresh_token: decryptSecret(data.refresh_token_encrypted as string),
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!res.ok || !body.access_token) return null;
  await supabaseAdmin
    .from("connector_accounts")
    .update({ access_token_encrypted: encryptSecret(body.access_token), updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("provider", "google");
  return body.access_token;
}

/** Which connectors a user has linked (provider → granted scopes) — decides which tools a chat turn gets. */
export async function listConnectedProviders(userId: string): Promise<Map<string, string[]>> {
  const { data, error } = await supabaseAdmin.from("connector_accounts").select("provider, scopes").eq("user_id", userId);
  if (error) return new Map();
  return new Map((data ?? []).map((row) => [row.provider as string, (row.scopes as string[] | null) ?? []]));
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

export async function loadTokenCredentials(userId: string, provider: TokenConnectorId) {
  const { data, error } = await supabaseAdmin
    .from("connector_accounts")
    .select("access_token_encrypted, refresh_token_encrypted, metadata")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data?.access_token_encrypted) throw new HttpError(400, `Connect ${provider} first`);
  return {
    token: decryptSecret(data.access_token_encrypted as string),
    secret: data.refresh_token_encrypted ? decryptSecret(data.refresh_token_encrypted as string) : undefined,
    url: ((data.metadata as { url?: string } | null)?.url) ?? undefined,
  };
}

export async function connectTokenConnector(
  userId: string,
  provider: TokenConnectorId,
  input: { token?: string; secret?: string; url?: string },
) {
  const spec = TOKEN_CONNECTORS[provider];
  const verified = await spec.verify(input);
  const { data, error } = await supabaseAdmin
    .from("connector_accounts")
    .upsert(
      {
        user_id: userId,
        provider,
        external_account_id: verified.externalAccountId,
        account_login: verified.accountLogin,
        account_name: verified.accountName,
        access_token_encrypted: encryptSecret(input.token!.trim()),
        refresh_token_encrypted: input.secret?.trim() ? encryptSecret(input.secret.trim()) : null,
        scopes: [],
        metadata: verified.metadata,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider" },
    )
    .select("id, provider, account_login, account_name, scopes, connected_at")
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to save connector");

  await recordAdminAuditLog(userId, "connector.connect", "connector", data.id as string, { provider });

  return {
    id: data.id as string,
    provider: data.provider as ConnectorProvider,
    accountLogin: (data.account_login as string | null) ?? null,
    accountName: (data.account_name as string | null) ?? null,
    scopes: (data.scopes as string[] | null) ?? [],
    connectedAt: data.connected_at as string,
    configured: true,
  };
}

export async function previewConnector(userId: string, provider: ConnectorProvider, query = "") {
  if (provider === "github") {
    const repositories = await searchGitHubRepositories(userId, query);
    return repositories.map((repo) => ({
      title: repo.fullName,
      subtitle: repo.description,
      url: repo.url,
    }));
  }
  if (provider === "google") {
    return [{ title: "Google connected", subtitle: "Calendar, Gmail, and Drive share this account" }];
  }
  if (!isTokenConnector(provider)) throw new HttpError(400, "Unknown connector");
  const credentials = await loadTokenCredentials(userId, provider);
  return TOKEN_CONNECTORS[provider].preview(credentials);
}
