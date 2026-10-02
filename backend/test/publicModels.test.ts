import assert from "node:assert/strict";
import test from "node:test";
import { isBuildModel } from "../src/services/projectBuild/buildModels.js";

// The Build model picker shows only models flagged `build` by GET /models — the deployed model list must match.
test("the frontier models Friday ships are Build-capable, lightweight ones are not", () => {
  for (const m of [
    { slug: "scalemax", modelId: "claude-opus-5", displayName: "Claude Opus 5" },
    { slug: "scalemax", modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
    { slug: "scalemax", modelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
  ]) assert.equal(isBuildModel(m), true, m.modelId);
  assert.equal(isBuildModel({ slug: "scalemax", modelId: "claude-haiku-4-5", displayName: "Haiku" }), false);
  assert.equal(isBuildModel({ slug: "scalemax", modelId: "gpt-5-mini", displayName: "GPT-5 mini" }), false);
});
