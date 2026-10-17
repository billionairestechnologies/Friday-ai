import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { logger } from "../../utils/logger.js";
import { memoAsync } from "../../utils/ttlMemo.js";
import { listCliSessions, revokeCliSession } from "../cli/deviceAuth.js";

/**
 * Sessions & devices (supabase 0068, phase 11). Every web/Android/iOS request carries a Supabase
 * access token whose `session_id` claim names the sign-in; requireAuth calls `guardSession`, which
 * records it (≤ once a minute per session) and refuses a revoked one. FridayX CLI/IDE sign-ins are
 * the cli_tokens rows (0050) and are listed alongside.
 *
 * Fails OPEN: if the sessions table isn't there (migration not applied) or the database blips, the
 * request goes through — a device page must never be able to sign everyone out.
 */

export type Platform = "web" | "android" | "ios" | "other";

/** The `session_id` claim of a Supabase access token (already verified by auth.getUser), or null. */
export function sessionIdFromToken(token: string): string | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { session_id?: unknown };
    const id = typeof claims.session_id === "string" ? claims.session_id : null;
    return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Which app sent the request: an explicit X-Friday-Platform header wins, else the user agent. */
export function platformOf(userAgent: string | undefined, header?: string | undefined): Platform {
  const h = (header ?? "").toLowerCase();
  if (h === "web" || h === "android" || h === "ios") return h;
  const ua = userAgent ?? "";
  if (/okhttp|Dalvik/i.test(ua)) return "android";
  if (/CFNetwork|Darwin\/|FridayApp/i.test(ua) && !/Mozilla/i.test(ua)) return "ios";
  return ua ? "web" : "other";
}

/** "Chrome on macOS", "Friday for Android"… — a label a person recognises, never the raw UA. */
export function describeClient(userAgent: string | undefined, platform: Platform): string {
  if (platform === "android") return "Friday for Android";
  if (platform === "ios") return "Friday for iPhone";
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** Coarse location hint only: a.b.c.x for IPv4, the first three groups for IPv6. */
export function ipPrefix(ip: string | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return `${v4.split(".").slice(0, 3).join(".")}.x`;
  if (ip.includes(":")) return `${ip.split(":").slice(0, 3).join(":")}::`;
  return null;
}

// Revoked in THIS process — honoured instantly, before the touch memo would notice.
const revokedHere = new Set<string>();
let warned = false;

type TouchArgs = { sessionId: string; userId: string; platform: Platform; client: string; ip: string | null; maxDevices: number };

const touch = memoAsync(
  60_000,
  async (a: TouchArgs): Promise<"ok" | "revoked"> => {
    const { data, error } = await supabaseAdmin.rpc("session_touch", {
      p_session: a.sessionId,
      p_user: a.userId,
      p_platform: a.platform,
      p_client: a.client,
      p_ip: a.ip,
      p_max: a.maxDevices,
    });
    if (error) {
      if (!warned) logger.warn("session tracking unavailable (is migration 0068 applied?)", { error: error.message });
      warned = true;
      return "ok";
    }
    return data === "revoked" ? "revoked" : "ok";
  },
  (a) => a.sessionId,
);

/** Throws 401 for a signed-out session; otherwise records the use. Never throws for a DB problem. */
export async function guardSession(input: { token: string; userId: string; userAgent?: string; platformHeader?: string; ip?: string; maxDevices: () => Promise<number> }): Promise<void> {
  const sessionId = sessionIdFromToken(input.token);
  if (!sessionId) return;
  if (revokedHere.has(sessionId)) throw new HttpError(401, "This device was signed out. Sign in again to continue.");
  const platform = platformOf(input.userAgent, input.platformHeader);
  const state = await touch({
    sessionId,
    userId: input.userId,
    platform,
    client: describeClient(input.userAgent, platform),
    ip: ipPrefix(input.ip),
    maxDevices: await input.maxDevices().catch(() => 0),
  }).catch(() => "ok" as const);
  if (state === "revoked") {
    revokedHere.add(sessionId);
    throw new HttpError(401, "This device was signed out. Sign in again to continue.");
  }
}

export type DeviceSession = {
  id: string;
  kind: "app" | "cli";
  platform: Platform | "cli";
  client: string;
  ipPrefix: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  current: boolean;
};

export async function listSessions(userId: string, currentToken?: string): Promise<DeviceSession[]> {
  const current = currentToken ? sessionIdFromToken(currentToken) : null;
  const [{ data, error }, cli] = await Promise.all([supabaseAdmin.rpc("session_list", { p_user: userId }), listCliSessions(userId).catch(() => [])]);
  if (error && !/does not exist|schema cache/i.test(error.message)) throw new HttpError(500, "Couldn't load your devices.");
  const apps: DeviceSession[] = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    kind: "app",
    platform: r.platform as Platform,
    client: (r.client as string) || "Unknown device",
    ipPrefix: (r.ip_prefix as string | null) ?? null,
    createdAt: r.created_at as string,
    lastSeenAt: r.last_seen_at as string,
    current: r.id === current,
  }));
  const tools: DeviceSession[] = cli.map((c) => ({
    id: c.id,
    kind: "cli",
    platform: "cli",
    client: c.name || c.client || "FridayX",
    ipPrefix: null,
    createdAt: c.createdAt,
    lastSeenAt: c.lastUsedAt,
    current: false,
  }));
  // The device in hand first, then most recently used.
  return [...apps, ...tools].sort((a, b) => Number(b.current) - Number(a.current) || (b.lastSeenAt ?? b.createdAt).localeCompare(a.lastSeenAt ?? a.createdAt));
}

async function revokeApp(userId: string, sessionId: string, reason: "user" | "user_others" | "admin"): Promise<boolean> {
  const { data: row } = await supabaseAdmin.from("user_sessions").select("id").eq("id", sessionId).eq("user_id", userId).maybeSingle();
  if (!row) return false;
  const { error } = await supabaseAdmin.rpc("session_revoke", { p_session: sessionId, p_reason: reason });
  if (error) throw new HttpError(500, "Couldn't sign that device out — try again.");
  revokedHere.add(sessionId);
  touch.invalidate(sessionId);
  return true;
}

/** Signs out one device (an app session or a FridayX sign-in). */
export async function revokeSession(userId: string, kind: "app" | "cli", id: string, by: "user" | "admin" = "user"): Promise<void> {
  if (kind === "cli") return revokeCliSession(userId, id);
  if (!(await revokeApp(userId, id, by))) throw new HttpError(404, "That device was already signed out.");
}

/** "Sign out everywhere else": every other app session and every FridayX sign-in. Returns how many. */
export async function revokeOthers(userId: string, currentToken: string | null, by: "user_others" | "admin" = "user_others"): Promise<number> {
  const keep = currentToken ? sessionIdFromToken(currentToken) : null;
  const sessions = await listSessions(userId);
  let n = 0;
  for (const s of sessions) {
    if (s.kind === "app" && s.id === keep) continue;
    if (s.kind === "app") n += Number(await revokeApp(userId, s.id, by));
    else {
      await revokeCliSession(userId, s.id).catch(() => undefined);
      n += 1;
    }
  }
  return n;
}
