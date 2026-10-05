import assert from "node:assert/strict";
import test from "node:test";
import { hashPassphrase, verifyPassphrase } from "../src/services/air/passphrase.js";

test("a passphrase matches only itself", () => {
  const stored = hashPassphrase("rukho-navy");
  assert.equal(verifyPassphrase("rukho-navy", stored), true);
  assert.equal(verifyPassphrase("rukho-navy ", stored), false);
  assert.equal(verifyPassphrase("other", stored), false);
  assert.equal(verifyPassphrase("rukho-navy", "nope"), false);
});
