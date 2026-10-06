import assert from "node:assert/strict";
import test from "node:test";
import { hashPassphrase, parseSpokenPassphrase, verifyPassphrase } from "../src/services/air/passphrase.js";

test("a passphrase matches only itself, forgiving what a transcriber adds", () => {
  const stored = hashPassphrase("rukho-navy");
  assert.equal(verifyPassphrase("rukho-navy", stored), true);
  // Speech-to-text returns case, spacing and punctuation of its own.
  assert.equal(verifyPassphrase("Rukho navy.", stored), true);
  assert.equal(verifyPassphrase("rukho-navy ", stored), true);
  assert.equal(verifyPassphrase("rukho", stored), false);
  assert.equal(verifyPassphrase("other", stored), false);
  assert.equal(verifyPassphrase("rukho-navy", "nope"), false);
});

test("passphrases hashed before normalisation still verify", async () => {
  const { randomBytes, scryptSync } = await import("node:crypto");
  const salt = randomBytes(16).toString("hex");
  const legacy = `scrypt:${salt}:${scryptSync("Jagga Jasoos", salt, 32).toString("hex")}`;
  assert.equal(verifyPassphrase("Jagga Jasoos", legacy), true);
});

test("changing a spoken passphrase names the old one", () => {
  assert.deepEqual(parseSpokenPassphrase("my passcode is jagga jasoos"), { phrase: "jagga jasoos", old: null });
  assert.deepEqual(parseSpokenPassphrase("change my passcode from jagga jasoos to naya naya"), { phrase: "naya naya", old: "jagga jasoos" });
  assert.deepEqual(parseSpokenPassphrase("change my passcode to naya naya"), { phrase: "naya naya", old: null });
  assert.equal(parseSpokenPassphrase("my passcode is ab"), null);
  assert.equal(parseSpokenPassphrase("hello"), null);
});
