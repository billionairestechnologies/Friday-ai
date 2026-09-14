import crypto from "node:crypto";
import { env } from "../config/env.js";

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  return crypto.createHash("sha256").update(env.keyEncryptionSecret).digest();
}

/** Encrypts a provider API key before it is stored in Supabase. */
export function encryptSecret(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(".");
}

/** Decrypts a provider API key read from Supabase. */
export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Returns a short masked preview of a secret, e.g. sk-ab12...9f3d, safe to show in the admin UI. */
export function maskSecret(plainText: string): string {
  if (plainText.length <= 8) return "****";
  return `${plainText.slice(0, 5)}...${plainText.slice(-4)}`;
}
