import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";

const KEYLEN = 32;

/** "my passcode is jagga jasoos" or "change my passcode to jagga jasoos". */
export function spokenPassphrase(text: string): string | null {
  const match = text.trim().match(/\b(?:my passcode is|change my passcode to)\s+(.+)$/i);
  const phrase = match?.[1]?.trim() ?? "";
  if (phrase.length < 4 || phrase.length > 80) return null;
  return phrase;
}

export function hashPassphrase(phrase: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(phrase, salt, KEYLEN).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassphrase(phrase: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split(":");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const got = scryptSync(phrase, salt, KEYLEN);
  const want = Buffer.from(hash, "hex");
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/** No passphrase set means ordinary actions still work. Once set, pay, send, and delete must present it. */
export async function assertPassphrase(userId: string, phrase: string | undefined) {
  const { data, error } = await supabaseAdmin.from("profiles").select("air_passphrase_hash").eq("id", userId).maybeSingle();
  if (error || !data) return;
  const stored = (data as { air_passphrase_hash?: string | null }).air_passphrase_hash;
  if (!stored) return;
  if (!phrase || !verifyPassphrase(phrase, stored)) {
    throw new HttpError(403, "Say your passphrase before this.");
  }
}

export async function savePassphrase(userId: string, phrase: string) {
  const trimmed = phrase.trim();
  if (trimmed.length < 4 || trimmed.length > 80) throw new HttpError(400, "Use a passphrase between 4 and 80 characters.");
  const { error } = await supabaseAdmin.from("profiles").update({ air_passphrase_hash: hashPassphrase(trimmed) }).eq("id", userId);
  if (error) throw new HttpError(500, error.message);
}
