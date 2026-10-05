import { supabaseAdmin } from "../../config/supabase.js";
import {
  DEFAULT_PHONE_CONFIG,
  DEFAULT_USER_PHONE_SETTINGS,
  type PhoneConfig,
  type UserPhoneSettings,
} from "./policy.js";

export type PresenceKind = "call" | "web" | "cli" | "sandbox";

type Presence = { userId: string; kind: PresenceKind; id: string; seenAt: number };

const presence = new Map<string, Presence>();
const minutes = new Map<string, number>();
const userSettings = new Map<string, UserPhoneSettings>();
const outbox: { userId: string; channel: string; text: string; at: number }[] = [];

let config: PhoneConfig = { ...DEFAULT_PHONE_CONFIG, channels: { ...DEFAULT_PHONE_CONFIG.channels }, enabledPlanIds: [...DEFAULT_PHONE_CONFIG.enabledPlanIds] };

const PRESENCE_TTL_MS = 60_000;

export function getPhoneConfig(): PhoneConfig {
  return config;
}

function applyConfig(next: PhoneConfig, persist: boolean) {
  config = {
    ...next,
    enabledPlanIds: [...next.enabledPlanIds],
    channels: { ...next.channels },
    voice: next.voice === "sarvam" ? "sarvam" : "gemini",
  };
  if (persist) void supabaseAdmin.from("phone_settings").upsert({ id: 1, config, updated_at: new Date().toISOString() }).then(() => undefined, () => undefined);
}

export function setPhoneConfig(next: PhoneConfig) {
  applyConfig(next, true);
}

let configLoaded = false;

/** Reads the admin record when the table exists. Defaults stay in place until then. */
export async function loadPhoneConfig() {
  if (configLoaded) return config;
  configLoaded = true;
  const { data, error } = await supabaseAdmin.from("phone_settings").select("config").eq("id", 1).maybeSingle();
  if (!error && data && (data as { config?: PhoneConfig }).config) applyConfig((data as { config: PhoneConfig }).config, false);
  return config;
}

export function getUserPhoneSettings(userId: string): UserPhoneSettings {
  return userSettings.get(userId) ?? { ...DEFAULT_USER_PHONE_SETTINGS, channels: [...DEFAULT_USER_PHONE_SETTINGS.channels] };
}

export function setUserPhoneSettings(userId: string, next: UserPhoneSettings) {
  const settings = { ...next, channels: [...next.channels] };
  userSettings.set(userId, settings);
  void supabaseAdmin.from("phone_preferences").upsert({ user_id: userId, settings, updated_at: new Date().toISOString() }).then(() => undefined, () => undefined);
}

export async function hydrateUserPhone(userId: string) {
  if (!userSettings.has(userId)) {
    const { data, error } = await supabaseAdmin.from("phone_preferences").select("settings").eq("user_id", userId).maybeSingle();
    if (!error && data && (data as { settings?: UserPhoneSettings }).settings) {
      const settings = (data as { settings: UserPhoneSettings }).settings;
      userSettings.set(userId, { ...settings, channels: [...settings.channels] });
    }
  }
  const key = monthKey(userId);
  if (!minutes.has(key)) {
    const month = key.split(":")[1] ?? "";
    const { data, error } = await supabaseAdmin.from("phone_minutes").select("seconds").eq("user_id", userId).eq("month", month).maybeSingle();
    if (!error && data) minutes.set(key, (data as { seconds: number }).seconds ?? 0);
  }
}

function monthKey(userId: string, now = new Date()) {
  return `${userId}:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function usedCallSeconds(userId: string, now = new Date()): number {
  return minutes.get(monthKey(userId, now)) ?? 0;
}

export function addCallSeconds(userId: string, seconds: number, now = new Date()) {
  const key = monthKey(userId, now);
  const total = (minutes.get(key) ?? 0) + Math.max(0, seconds);
  minutes.set(key, total);
  const month = key.split(":")[1] ?? "";
  void supabaseAdmin.from("phone_minutes").upsert({ user_id: userId, month, seconds: total }).then(() => undefined, () => undefined);
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
  minutes.clear();
  userSettings.clear();
  outbox.length = 0;
  setPhoneConfig(DEFAULT_PHONE_CONFIG);
  configLoaded = true;
}
