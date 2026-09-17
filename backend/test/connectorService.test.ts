import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

test("OAuth state round-trips user id and return path", async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key";
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "anon-key";
  process.env.KEY_ENCRYPTION_SECRET = process.env.KEY_ENCRYPTION_SECRET || "dev-only-insecure-secret";
  process.env.GITHUB_CLIENT_ID = "gh-client";
  process.env.GITHUB_CLIENT_SECRET = "gh-secret";

  const { parseOAuthState } = await import("../src/services/connectorService.js");
  const state = Buffer.from(
    JSON.stringify({ userId: "user-1", nonce: "abc", returnTo: "/?dialog=plugins" }),
    "utf8",
  ).toString("base64url");

  assert.deepEqual(parseOAuthState(state), {
    userId: "user-1",
    returnTo: "/?dialog=plugins",
    provider: undefined,
  });
});

test("Google login state only accepts login purpose", async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key";
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "anon-key";
  process.env.GOOGLE_CLIENT_ID = "gid";
  process.env.GOOGLE_CLIENT_SECRET = "gsecret";
  const { parseGoogleLoginState } = await import("../src/services/googleAuth.js");
  const state = Buffer.from(JSON.stringify({ purpose: "login", returnTo: "/app" }), "utf8").toString("base64url");
  assert.deepEqual(parseGoogleLoginState(state), { returnTo: "/app" });
  assert.throws(() => parseGoogleLoginState("nope"));
});

test("invite token hashing is stable", () => {
  const token = "invite-token-example";
  const hash = createHash("sha256").update(token).digest("hex");
  assert.equal(hash.length, 64);
  assert.equal(createHash("sha256").update(token).digest("hex"), hash);
});
