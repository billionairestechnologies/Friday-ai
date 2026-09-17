import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptPendingSession,
  encryptPendingSession,
  generateOtp,
  hashOtp,
  verifyOtpHash,
} from "../src/utils/authSecurity.js";

test("OTP generation returns a six-digit cryptographic code", () => {
  assert.match(generateOtp(), /^\d{6}$/);
});

test("OTP hashes are scoped to the normalized email", () => {
  const hash = hashOtp(" User@Example.com ", "123456");

  assert.equal(verifyOtpHash("user@example.com", "123456", hash), true);
  assert.equal(verifyOtpHash("user@example.com", "654321", hash), false);
  assert.equal(verifyOtpHash("other@example.com", "123456", hash), false);
});

test("pending sessions are encrypted and round-trip safely", () => {
  const session = { access_token: "secret-token", user: { id: "user-1" } };
  const ciphertext = encryptPendingSession(session);

  assert.equal(ciphertext.includes("secret-token"), false);
  assert.deepEqual(decryptPendingSession(ciphertext), session);
});
