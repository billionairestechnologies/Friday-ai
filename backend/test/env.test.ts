import assert from "node:assert/strict";
import test from "node:test";
import { validateEnvironment } from "../src/config/env.js";

const validProductionEnvironment = {
  nodeEnv: "production",
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "service-role-key",
  supabaseAnonKey: "anon-key",
  keyEncryptionSecret: "a-unique-production-secret-that-is-long-enough",
  resendApiKey: "re_test",
};

test("production environment accepts required secure values", () => {
  assert.deepEqual(validateEnvironment(validProductionEnvironment), []);
});

test("production environment rejects missing services and weak encryption", () => {
  const errors = validateEnvironment({
    ...validProductionEnvironment,
    supabaseUrl: "",
    keyEncryptionSecret: "dev-only-insecure-secret",
    resendApiKey: "",
  });

  assert.ok(errors.some((error) => error.includes("SUPABASE_URL")));
  assert.ok(errors.some((error) => error.includes("KEY_ENCRYPTION_SECRET")));
  assert.ok(errors.some((error) => error.includes("RESEND_API_KEY")));
});

test("development still requires Supabase but permits local-only secrets", () => {
  assert.deepEqual(
    validateEnvironment({
      ...validProductionEnvironment,
      nodeEnv: "development",
      keyEncryptionSecret: "dev-only-insecure-secret",
      resendApiKey: "",
    }),
    [],
  );
});

test("partial GitHub and SSO config are rejected", () => {
  assert.ok(
    validateEnvironment({
      ...validProductionEnvironment,
      githubClientId: "only-id",
    }).some((error) => error.includes("GITHUB_CLIENT_ID")),
  );
  assert.ok(
    validateEnvironment({
      ...validProductionEnvironment,
      ssoEnabled: true,
      ssoEntryUrl: "",
    }).some((error) => error.includes("SSO_ENTRY_URL")),
  );
});

test("FRIDAY_ENV_JSON (AWS Secrets Manager) fills unset variables without overriding explicit ones", async () => {
  const { expandJsonEnv } = await import("../src/config/env.js");
  const target: NodeJS.ProcessEnv = { REDIS_URL: "redis://from-stack:6379", EMPTY: "" };
  const applied = expandJsonEnv(JSON.stringify({ SUPABASE_URL: "https://x.supabase.co", REDIS_URL: "redis://from-secret", EMPTY: "filled", PORT: 4000, bad_key: "x", FCM: { a: 1 } }), target);
  assert.equal(target.SUPABASE_URL, "https://x.supabase.co");
  assert.equal(target.REDIS_URL, "redis://from-stack:6379");
  assert.equal(target.EMPTY, "filled");
  assert.equal(target.PORT, "4000");
  assert.equal(target.bad_key, undefined);
  assert.equal(target.FCM, '{"a":1}');
  assert.equal(applied, 4);
  assert.equal(expandJsonEnv(undefined, target), 0);
  assert.throws(() => expandJsonEnv("{nope", target), /not valid JSON/);
});
