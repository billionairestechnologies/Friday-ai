import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { decryptSecret, encryptSecret } from "./crypto.js";

const SESSION_CONTEXT = "friday-login-session:";

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function generateOtp(): string {
  return String(randomInt(100_000, 1_000_000));
}

export function hashOtp(email: string, code: string): string {
  return createHmac("sha256", env.keyEncryptionSecret)
    .update(`friday-login-otp:${normalizedEmail(email)}:${code}`)
    .digest("base64url");
}

export function verifyOtpHash(email: string, code: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOtp(email, code));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function encryptPendingSession(session: unknown): string {
  return encryptSecret(`${SESSION_CONTEXT}${JSON.stringify(session)}`);
}

export function decryptPendingSession<T>(ciphertext: string): T {
  const plaintext = decryptSecret(ciphertext);
  if (!plaintext.startsWith(SESSION_CONTEXT)) {
    throw new Error("Invalid login session payload");
  }
  return JSON.parse(plaintext.slice(SESSION_CONTEXT.length)) as T;
}
