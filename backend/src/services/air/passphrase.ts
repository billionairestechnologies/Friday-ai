import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { logger } from "../../utils/logger.js";

const KEYLEN = 32;
export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;

export type SpokenPassphrase = { phrase: string; old: string | null };

/**
 * "my passcode is jagga jasoos" (first time), or "change my passcode from jagga jasoos to naya naya".
 * Changing needs the old one: caller ID alone must not be enough to reset the check that protects
 * payments and sends. "change my passcode to X" is still understood, but only works when none is set.
 */
export function parseSpokenPassphrase(text: string): SpokenPassphrase | null {
  const t = text.trim();
  const change = t.match(/\bchange my pass(?:code|phrase) from\s+(.+?)\s+to\s+(.+)$/i);
  if (change) {
    const [old, phrase] = [change[1]!.trim(), change[2]!.trim()];
    return phrase.length >= 4 && phrase.length <= 80 ? { phrase, old } : null;
  }
  const set = t.match(/\b(?:my pass(?:code|phrase) is|change my pass(?:code|phrase) to)\s+(.+)$/i);
  const phrase = set?.[1]?.trim() ?? "";
  if (phrase.length < 4 || phrase.length > 80) return null;
  return { phrase, old: null };
}

/** Kept for older callers: just the new phrase. */
export function spokenPassphrase(text: string): string | null {
  return parseSpokenPassphrase(text)?.phrase ?? null;
}

export function hashPassphrase(phrase: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(normalize(phrase), salt, KEYLEN).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

/** Spoken input arrives with stray case, punctuation and spacing from the transcriber. */
function normalize(phrase: string) {
  return phrase.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function verifyPassphrase(phrase: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split(":");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  for (const candidate of [normalize(phrase), phrase]) {
    const got = scryptSync(candidate, salt, KEYLEN);
    if (got.length === want.length && timingSafeEqual(got, want)) return true;
  }
  return false;
}

type Row = { air_passphrase_hash?: string | null; air_passphrase_failures?: number | null; air_passphrase_locked_until?: string | null };

async function loadRow(userId: string): Promise<Row | null> {
  const { data, error } = await supabaseAdmin.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error || !data) return null;
  return data as Row;
}

export async function hasPassphrase(userId: string): Promise<boolean> {
  return Boolean((await loadRow(userId))?.air_passphrase_hash);
}

/**
 * No passphrase set means ordinary actions still work. Once set, pay, send and delete must present it.
 * Five wrong tries lock it for 15 minutes and tell the person — caller ID can be spoofed, so guesses
 * over the phone must not be free.
 */
export async function assertPassphrase(userId: string, phrase: string | undefined) {
  const row = await loadRow(userId);
  const stored = row?.air_passphrase_hash;
  if (!stored) return;
  const lockedUntil = row?.air_passphrase_locked_until ? new Date(row.air_passphrase_locked_until).getTime() : 0;
  if (lockedUntil > Date.now()) {
    const minutes = Math.ceil((lockedUntil - Date.now()) / 60_000);
    throw new HttpError(429, `Too many wrong tries. The passphrase is locked for ${minutes} more minute${minutes === 1 ? "" : "s"}.`);
  }
  if (phrase && verifyPassphrase(phrase, stored)) {
    if (row?.air_passphrase_failures) await supabaseAdmin.from("profiles").update({ air_passphrase_failures: 0, air_passphrase_locked_until: null }).eq("id", userId);
    return;
  }
  if (!phrase) throw new HttpError(403, "Say your passphrase before this.");
  const failures = (row?.air_passphrase_failures ?? 0) + 1;
  const lock = failures >= MAX_FAILURES;
  await supabaseAdmin
    .from("profiles")
    .update({ air_passphrase_failures: lock ? 0 : failures, air_passphrase_locked_until: lock ? new Date(Date.now() + LOCK_MS).toISOString() : null })
    .eq("id", userId);
  if (lock) {
    logger.warn("air_passphrase_locked", { userId });
    const { deliverResult } = await import("../phone/delivery.js");
    const { loadPhoneConfig } = await import("../phone/store.js");
    await deliverResult(
      userId,
      null,
      "Someone got your Friday passphrase wrong 5 times, so it's locked for 15 minutes. If that wasn't you, change it in Air Dots settings.",
      ["app", "telegram", "whatsapp"],
      await loadPhoneConfig(),
    ).catch(() => undefined);
    throw new HttpError(429, "Too many wrong tries. The passphrase is locked for 15 minutes.");
  }
  throw new HttpError(403, "That passphrase didn't match.");
}

export async function savePassphrase(userId: string, phrase: string) {
  const trimmed = phrase.trim();
  if (trimmed.length < 4 || trimmed.length > 80) throw new HttpError(400, "Use a passphrase between 4 and 80 characters.");
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ air_passphrase_hash: hashPassphrase(trimmed), air_passphrase_failures: 0, air_passphrase_locked_until: null })
    .eq("id", userId);
  if (error) throw new HttpError(500, error.message);
}

/** Set by voice / chat: the first one freely, a change only with the old one. */
export async function setSpokenPassphrase(userId: string, spoken: SpokenPassphrase): Promise<string> {
  if (await hasPassphrase(userId)) {
    if (!spoken.old) return "You already have a passphrase. Say: change my passcode from the old one to the new one.";
    await assertPassphrase(userId, spoken.old);
  }
  await savePassphrase(userId, spoken.phrase);
  return "Saved. I'll ask for it before a payment, a send, or a delete.";
}
