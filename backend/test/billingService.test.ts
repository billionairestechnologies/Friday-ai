import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

test("Razorpay webhook verification accepts only matching signatures", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
  process.env.SUPABASE_ANON_KEY = "anon";
  const { env } = await import("../src/config/env.js");
  const { verifyRazorpayWebhook } = await import("../src/services/billingService.js");
  env.razorpayWebhookSecret = "test-webhook-secret";
  const body = Buffer.from(JSON.stringify({ event: "payment.captured" }));
  const signature = createHmac("sha256", env.razorpayWebhookSecret).update(body).digest("hex");

  assert.equal(verifyRazorpayWebhook(body, signature), true);
  assert.equal(verifyRazorpayWebhook(body, "bad-signature"), false);
});
