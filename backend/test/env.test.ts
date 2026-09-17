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
