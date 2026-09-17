import assert from "node:assert/strict";
import test from "node:test";

const FEATURED_PLUGIN_IDS = [
  "calendar",
  "github",
  "gmail",
  "drive",
  "notion",
  "supabase",
  "railway",
  "finance",
  "box",
  "canva",
  "razorpay",
  "vercel",
];

test("connector catalog covers every featured plugin", async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key";
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "anon-key";
  const { connectorConfig } = await import("../src/services/connectorService.js");
  const config = connectorConfig();
  const covered = new Set(Object.values(config).flatMap((spec) => spec.pluginIds));
  for (const pluginId of FEATURED_PLUGIN_IDS) {
    assert.ok(covered.has(pluginId), `missing connector for ${pluginId}`);
  }
});
