import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateCostCents,
  estimateTokenUsageFromText,
  mergeTokenUsage,
} from "../src/services/tokenUsage.js";

test("token usage estimation is positive and marked estimated", () => {
  const usage = estimateTokenUsageFromText(400, 120);
  assert.equal(usage.estimated, true);
  assert.ok(usage.promptTokens >= 100);
  assert.ok(usage.completionTokens >= 30);
  assert.equal(usage.totalTokens, usage.promptTokens + usage.completionTokens);
});

test("cost estimate is zero for ollama and positive for openai", () => {
  const usage = { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 };
  assert.equal(estimateCostCents("ollama", usage), 0);
  assert.ok(estimateCostCents("openai", usage) > 0);
});

test("mergeTokenUsage sums both sides", () => {
  const merged = mergeTokenUsage(
    { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    { promptTokens: 2, completionTokens: 3, totalTokens: 5, estimated: true },
  );
  assert.deepEqual(merged, {
    promptTokens: 12,
    completionTokens: 8,
    totalTokens: 20,
    estimated: true,
  });
});
