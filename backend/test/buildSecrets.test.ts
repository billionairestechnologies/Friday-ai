import assert from "node:assert/strict";
import test from "node:test";
import { SECRET_NAME, redactSecrets } from "../src/services/projectBuild/secrets.js";

test("secret values never survive in output", () => {
  const secrets = { STRIPE_KEY: "sk_live_abc123", DB_URL: "postgres://u:p@h/db" };
  const out = redactSecrets("key=sk_live_abc123 url=postgres://u:p@h/db again sk_live_abc123", secrets);
  assert.equal(out, "key=[secret STRIPE_KEY] url=[secret DB_URL] again [secret STRIPE_KEY]");
});

test("very short values aren't redacted (would mangle ordinary output)", () => {
  assert.equal(redactSecrets("a b c", { X: "b" }), "a b c");
});

test("secret names are UPPER_SNAKE_CASE", () => {
  for (const ok of ["API_KEY", "STRIPE_SECRET_KEY", "A1"]) assert.ok(SECRET_NAME.test(ok), ok);
  for (const bad of ["api_key", "1KEY", "MY-KEY", "", "A".repeat(65)]) assert.ok(!SECRET_NAME.test(bad), bad);
});
