import assert from "node:assert/strict";
import test from "node:test";
import { buildCandidates, isBuildModel } from "../src/services/projectBuild/buildModels.js";
import { reasoningParams } from "../src/services/providers/toolCalling.js";
import { meterValue } from "../src/services/quota/tokenQuotaService.js";

const m = (slug: string, modelId: string) => ({ slug, modelId, displayName: modelId });

test("Build allow-list: frontier coding models in, light models out", () => {
  for (const ok of [m("anthropic", "claude-sonnet-4-5"), m("anthropic", "claude-opus-4-1"), m("openai", "gpt-5"), m("openai", "gpt-4.1"), m("gemini", "gemini-2.5-pro"), m("openrouter", "qwen/qwen3-coder"), m("openrouter", "deepseek/deepseek-v3.1")]) {
    assert.ok(isBuildModel(ok), `${ok.modelId} should drive Build`);
  }
  for (const no of [m("openai", "gpt-5-mini"), m("openai", "gpt-4.1-nano"), m("anthropic", "claude-3-5-haiku"), m("gemini", "gemini-2.5-flash"), m("openai", "gpt-4o-mini"), m("sarvam", "sarvam-m")]) {
    assert.ok(!isBuildModel(no), `${no.modelId} must not drive Build`);
  }
});

test("FRIDAY_BUILD_MODELS overrides the list; a bad regex falls back to the default", () => {
  process.env.FRIDAY_BUILD_MODELS = "gemini-2\\.5-flash";
  assert.ok(isBuildModel(m("gemini", "gemini-2.5-flash-preview")));
  assert.ok(!isBuildModel(m("openai", "gpt-5")));
  process.env.FRIDAY_BUILD_MODELS = "([";
  assert.ok(isBuildModel(m("openai", "gpt-5")));
  delete process.env.FRIDAY_BUILD_MODELS;
});

test("buildCandidates never leaves Build without a model", () => {
  const weak = [m("openai", "gpt-4o-mini")];
  assert.deepEqual(buildCandidates(weak, () => false), weak);
  const mixed = [m("openai", "gpt-4o-mini"), m("anthropic", "claude-sonnet-4-5")];
  assert.deepEqual(buildCandidates(mixed, () => true).map((c) => c.modelId), ["claude-sonnet-4-5"]);
});

test("effort maps onto each provider's own reasoning control, only where it is accepted", () => {
  assert.deepEqual(reasoningParams("openai", "gpt-5", "medium"), {}, "medium = provider default, nothing sent");
  assert.deepEqual(reasoningParams("openai", "gpt-5", "high"), { reasoning_effort: "high" });
  assert.deepEqual(reasoningParams("openai", "gpt-4o", "high"), {}, "non-reasoning models would reject the field");
  assert.deepEqual(reasoningParams("openrouter", "openai/o3", "low"), { reasoning: { effort: "low" } });
  assert.deepEqual(reasoningParams("openrouter", "anthropic/claude-sonnet-4.5", "high"), {}, "thinking + tools needs block round-trips");
  assert.deepEqual(reasoningParams("gemini", "gemini-2.5-pro", "low"), { generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } });
  assert.deepEqual(reasoningParams("gemini", "gemini-3-pro-preview", "high"), { generationConfig: { thinkingConfig: { thinkingLevel: "high" } } });
});

test("usage meters never show a negative or over-limit value", () => {
  assert.equal(meterValue(-1200, 50_000), 0);
  assert.equal(meterValue(70_000, 50_000), 50_000);
  assert.equal(meterValue(NaN, 10), 0);
  assert.equal(meterValue(42, 100), 42);
});
