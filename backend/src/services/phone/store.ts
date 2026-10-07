import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../utils/logger.js";
import {
  DEFAULT_PHONE_CONFIG,
  DEFAULT_USER_PHONE_SETTINGS,
  type PhoneConfig,
  type UserPhoneSettings,
} from "./policy.js";

/**
 * Phone state that must agree across instances lives in Postgres: the admin config (re-read every
 * minute so a console change reaches every server), each person's delivery settings, and the monthly
 * call seconds (added with one atomic SQL call — migration 0056 — so two calls ending at once can't
 * lose seconds). Before, minutes and settings were per-server Maps hydrated once: a second instance
 * could let someone talk past their cap.
 *
 * Presence (is the person's web app / CLI open right now) stays in memory on purpose: it is a soft
 * hint for "do it on my machine", refreshed every few seconds by the clients, and losing it only
 * means Friday offers the sandbox instead.
 */

export type PresenceKind = "call" | "web" | "cli" | "sandbox";

type Presence = { userId: string; kind: PresenceKind; id: string; seenAt: number };

const presence = new Map<string, Presence>();
const outbox: { userId: string; channel: string; text: string; at: number }[] = [];

let config: PhoneConfig = cloneConfig(DEFAULT_PHONE_CONFIG);
let configLoadedAt = 0;
const CONFIG_TTL_MS = 60_000;
const PRESENCE_TTL_MS = 60_000;

function cloneConfig(next: PhoneConfig): PhoneConfig {
  return {
    ...DEFAULT_PHONE_CONFIG,
    ...next,
    enabledPlanIds: [...(next.enabledPlanIds ?? DEFAULT_PHONE_CONFIG.enabledPlanIds)],
    channels: { ...DEFAULT_PHONE_CONFIG.channels, ...(next.channels ?? {}) },
    voice: next.voice === "sarvam" ? "sarvam" : "gemini",
  };
}

/** The last loaded config (sync, for code paths that already awaited loadPhoneConfig). */
export function getPhoneConfig(): PhoneConfig {
  return config;
}

export async function setPhoneConfig(next: PhoneConfig) {
  config = cloneConfig(next);
  configLoadedAt = Date.now();
  const { error } = await supabaseAdmin.from("phone_settings").upsert({ id: 1, config, updated_at: new Date().toISOString() });
  if (error) logger.warn("phone_config_save_failed", { error: error.message });
}

/** Reads the admin record (at most once a minute). Defaults stay in place until the table exists. */
export async function loadPhoneConfig(force = false) {
  if (!force && Date.now() - configLoadedAt < CONFIG_TTL_MS) return config;
  configLoadedAt = Date.now();
  const { data, error } = await supabaseAdmin.from("phone_settings").select("config").eq("id", 1).maybeSingle();
  if (!error && data && (data as { config?: PhoneConfig }).config) config = cloneConfig((data as { config: PhoneConfig }).config);
  return config;
}

export async function getUserPhoneSettings(userId: string): Promise<UserPhoneSettings> {
  const fallback = { ...DEFAULT_USER_PHONE_SETTINGS, channels: [...DEFAULT_USER_PHONE_SETTINGS.channels] };
  if (!userId) return fallback;
  const { data, error } = await supabaseAdmin.from("phone_preferences").select("settings").eq("user_id", userId).maybeSingle();
  const settings = !error ? (data as { settings?: UserPhoneSettings } | null)?.settings : null;
  return settings ? { ...fallback, ...settings, channels: [...(settings.channels ?? fallback.channels)] } : fallback;
}

export async function setUserPhoneSettings(userId: string, next: UserPhoneSettings) {
  const settings = { ...next, channels: [...next.channels] };
  const { error } = await supabaseAdmin.from("phone_preferences").upsert({ user_id: userId, settings, updated_at: new Date().toISOString() });
  if (error) logger.warn("phone_preferences_save_failed", { userId, error: error.message });
  return settings;
}

export function monthOf(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function usedCallSeconds(userId: string, now = new Date()): Promise<number> {
  const { data, error } = await supabaseAdmin.from("phone_minutes").select("seconds").eq("user_id", userId).eq("month", monthOf(now)).maybeSingle();
  if (error) return 0;
  return (data as { seconds?: number } | null)?.seconds ?? 0;
}

/** Atomic add; returns the month's new total. */
export async function addCallSeconds(userId: string, seconds: number, now = new Date()): Promise<number> {
  const add = Math.max(0, Math.round(seconds));
  if (!add) return usedCallSeconds(userId, now);
  const { data, error } = await supabaseAdmin.rpc("air_add_call_seconds", { p_user: userId, p_month: monthOf(now), p_seconds: add });
  if (error) {
    logger.warn("call_seconds_add_failed", { userId, error: error.message });
    return usedCallSeconds(userId, now);
  }
  return Number(data) || 0;
}

export function registerPresence(userId: string, kind: PresenceKind, id: string = kind) {
  presence.set(`${userId}:${kind}:${id}`, { userId, kind, id, seenAt: Date.now() });
}

export function listPresence(userId: string): Presence[] {
  const now = Date.now();
  return [...presence.values()].filter((row) => row.userId === userId && now - row.seenAt < PRESENCE_TTL_MS);
}

export function machineOnline(userId: string): boolean {
  return listPresence(userId).some((row) => row.kind === "web" || row.kind === "cli");
}

export function queueDelivery(userId: string, channel: string, text: string) {
  outbox.push({ userId, channel, text: text.slice(0, 4000), at: Date.now() });
  if (outbox.length > 200) outbox.shift();
}

export function recentDeliveries(userId: string) {
  return outbox.filter((row) => row.userId === userId).slice(-20);
}

/** Test-only reset. */
export function resetPhoneStore() {
  presence.clear();
  outbox.length = 0;
  config = cloneConfig(DEFAULT_PHONE_CONFIG);
  configLoadedAt = Date.now();
}
