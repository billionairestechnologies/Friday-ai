import { createHash, randomBytes, randomInt } from "node:crypto";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { memoAsync } from "../../utils/ttlMemo.js";

/**
 * Device-code login for Friday X (CLI + IDE extensions), shaped like RFC 8628 so any OAuth-minded client
 * can drive it: the CLI asks for a code pair, the user approves the short code in the signed-in web app,
 * the CLI polls and is handed a long-lived token. Why not just reuse the Supabase session: it expires in
 * an hour, and a refresh token sitting in a dotfile would be a full-account credential. A CLI token is
 * scoped to /api/x/*, stored only as a SHA-256, and revocable per device from Settings.
 */

export const CLI_TOKEN_PREFIX = "fxt_";
export const DEVICE_CODE_TTL_SECONDS = 10 * 60;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

// No 0/O/1/I/L/U: a code read off a terminal and typed into a browser must survive a bad font.
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789";

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateUserCode(): string {
  const pick = () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]!;
  const half = () => Array.from({ length: 4 }, pick).join("");
  return `${half()}-${half()}`;
}

/** "abcd efgh", "ABCD-EFGH", " abcdefgh " → "ABCD-EFGH"; null when it can't be a code. */
export function normalizeUserCode(raw: string): string | null {
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== 8) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function generateCliToken(): string {
  return CLI_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function looksLikeCliToken(token: string): boolean {
  return token.startsWith(CLI_TOKEN_PREFIX) && token.length > CLI_TOKEN_PREFIX.length + 20;
}

export type DeviceStart = {
  device_code: string;
  user_code: string;
  expires_in: number;
  interval: number;
};

export async function startDeviceAuthorization(client: { name?: string; version?: string }): Promise<DeviceStart> {
  const deviceCode = randomBytes(32).toString("base64url");
  // A collision on the unique user_code is astronomically unlikely (27^8) but costs one retry, not an error page.
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode();
    const { error } = await supabaseAdmin.from("cli_device_codes").insert({
      device_code_hash: hashSecret(deviceCode),
      user_code: userCode,
      client_name: client.name?.slice(0, 80) ?? null,
      client_version: client.version?.slice(0, 40) ?? null,
      expires_at: new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000).toISOString(),
    });
    if (!error) return { device_code: deviceCode, user_code: userCode, expires_in: DEVICE_CODE_TTL_SECONDS, interval: DEVICE_POLL_INTERVAL_SECONDS };
    if (!/duplicate|unique/i.test(error.message)) throw new HttpError(500, "Couldn't start sign-in. Try again in a moment.");
  }
  throw new HttpError(500, "Couldn't start sign-in. Try again in a moment.");
}

export type DeviceRequestInfo = { userCode: string; clientName: string | null; clientVersion: string | null; expiresAt: string };

/** What the approval page shows so the user can tell it's THEIR terminal asking. */
export async function describeDeviceRequest(userCodeRaw: string): Promise<DeviceRequestInfo> {
  const userCode = normalizeUserCode(userCodeRaw);
  if (!userCode) throw new HttpError(400, "That code doesn't look right. It's 8 letters and numbers, like ABCD-EFGH.");
  const { data } = await supabaseAdmin
    .from("cli_device_codes")
    .select("user_code, client_name, client_version, expires_at, status")
    .eq("user_code", userCode)
    .maybeSingle();
  if (!data || data.status !== "pending" || Date.parse(data.expires_at as string) <= Date.now()) {
    throw new HttpError(404, "This code has expired or was already used. Run `friday login` again for a new one.");
  }
  return { userCode, clientName: data.client_name, clientVersion: data.client_version, expiresAt: data.expires_at as string };
}

export async function decideDeviceRequest(userId: string, userCodeRaw: string, approve: boolean): Promise<void> {
  const info = await describeDeviceRequest(userCodeRaw);
  // status = 'pending' in the WHERE makes this a compare-and-set: two tabs approving, or approve racing deny, can't both win.
  const { data, error } = await supabaseAdmin
    .from("cli_device_codes")
    .update({ status: approve ? "approved" : "denied", user_id: userId })
    .eq("user_code", info.userCode)
    .eq("status", "pending")
    .select("id");
  if (error) throw new HttpError(500, "Couldn't save your choice. Try again.");
  if (!data?.length) throw new HttpError(409, "This code was already handled.");
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "approved"; token: string; userId: string };

export async function pollDeviceAuthorization(deviceCode: string): Promise<DevicePoll> {
  const hash = hashSecret(deviceCode);
  const { data: row } = await supabaseAdmin
    .from("cli_device_codes")
    .select("id, status, user_id, expires_at, last_polled_at, client_name")
    .eq("device_code_hash", hash)
    .maybeSingle();
  if (!row) return { status: "expired" };
  if (Date.parse(row.expires_at as string) <= Date.now() && row.status !== "approved") return { status: "expired" };
  if (row.status === "denied") return { status: "denied" };
  if (row.status === "used") return { status: "expired" };

  const now = Date.now();
  const last = row.last_polled_at ? Date.parse(row.last_polled_at as string) : 0;
  void supabaseAdmin.from("cli_device_codes").update({ last_polled_at: new Date(now).toISOString() }).eq("id", row.id);
  if (row.status === "pending") {
    // RFC 8628 §3.5: a client that polls faster than `interval` is told to back off.
    return now - last < (DEVICE_POLL_INTERVAL_SECONDS - 1) * 1000 ? { status: "slow_down" } : { status: "pending" };
  }

  // approved → exactly one poll gets to turn it into a token.
  const { data: claimed } = await supabaseAdmin.from("cli_device_codes").update({ status: "used" }).eq("id", row.id).eq("status", "approved").select("id");
  if (!claimed?.length || !row.user_id) return { status: "expired" };
  const token = generateCliToken();
  const { error } = await supabaseAdmin.from("cli_tokens").insert({
    user_id: row.user_id,
    token_hash: hashSecret(token),
    name: row.client_name ? String(row.client_name) : "Friday X",
    client: /code|vscode|jetbrains|zed|ide/i.test(String(row.client_name ?? "")) ? "ide" : "cli",
  });
  if (error) throw new HttpError(500, "Couldn't finish signing in. Run `friday login` again.");
  return { status: "approved", token, userId: row.user_id as string };
}

export type CliPrincipal = { tokenId: string; userId: string };

// Every gateway request authenticates; the hash lookup is memoised briefly (revocation is honoured within the TTL).
const principalForHash = memoAsync(20_000, async (hash: string): Promise<CliPrincipal | null> => {
  const { data } = await supabaseAdmin.from("cli_tokens").select("id, user_id, revoked_at, last_used_at").eq("token_hash", hash).maybeSingle();
  if (!data || data.revoked_at) return null;
  const lastUsed = data.last_used_at ? Date.parse(data.last_used_at as string) : 0;
  if (Date.now() - lastUsed > 10 * 60_000) void supabaseAdmin.from("cli_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return { tokenId: data.id as string, userId: data.user_id as string };
}, (hash) => hash);

export async function principalForToken(token: string): Promise<CliPrincipal | null> {
  if (!looksLikeCliToken(token)) return null;
  return principalForHash(hashSecret(token));
}

export type CliSession = { id: string; name: string; client: string; createdAt: string; lastUsedAt: string | null };

export async function listCliSessions(userId: string): Promise<CliSession[]> {
  const { data } = await supabaseAdmin
    .from("cli_tokens")
    .select("id, name, client, created_at, last_used_at")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  return (data ?? []).map((r) => ({ id: r.id as string, name: r.name as string, client: r.client as string, createdAt: r.created_at as string, lastUsedAt: (r.last_used_at as string | null) ?? null }));
}

export async function revokeCliSession(userId: string, tokenId: string): Promise<void> {
  const { data: row } = await supabaseAdmin.from("cli_tokens").select("token_hash").eq("id", tokenId).eq("user_id", userId).is("revoked_at", null).maybeSingle();
  if (!row) throw new HttpError(404, "That session was already signed out.");
  await supabaseAdmin.from("cli_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", tokenId).eq("user_id", userId);
  principalForHash.invalidate(row.token_hash as string);
}

/** Housekeeping for the scheduler: expired device codes are dead weight. */
export async function purgeExpiredDeviceCodes(): Promise<void> {
  await supabaseAdmin.from("cli_device_codes").delete().lt("expires_at", new Date(Date.now() - 24 * 3600_000).toISOString());
}
