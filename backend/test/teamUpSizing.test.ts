import assert from "node:assert/strict";
import test from "node:test";
import { TEAMUP_HARD_CAP, TEAMUP_MAX_MODELS, teamUpProposerCount } from "../src/services/chat/candidates.js";
import type { ChatCandidate } from "../src/services/providerService.js";

function candidate(slug: string, vision = false): ChatCandidate {
  return { slug, providerDisplayName: slug, modelId: `${slug}-model`, displayName: slug, vision, minTier: "free" } as ChatCandidate;
}

// 8 distinct providers so the hard cap (6), not "how many are enabled", is what's being tested.
const POOL: ChatCandidate[] = [
  candidate("openai"),
  candidate("anthropic"),
  candidate("gemini"),
  candidate("openrouter"),
  candidate("sarvam"),
  candidate("scalemax"),
  candidate("ollama"),
  candidate("fable"),
];

test("plain messages keep the historical default of 3", () => {
  assert.equal(teamUpProposerCount(POOL, "what's the capital of France?"), TEAMUP_MAX_MODELS);
  assert.equal(teamUpProposerCount(POOL, "write a haiku about autumn"), TEAMUP_MAX_MODELS);
});

test("never exceeds however many distinct providers are actually enabled", () => {
  const small = POOL.slice(0, 2); // only 2 distinct providers enabled
  assert.equal(teamUpProposerCount(small, "compare pros and cons in depth, use 6 models"), 2);
  const three = POOL.slice(0, 3);
  assert.equal(teamUpProposerCount(three, "give me every angle, use 5 models"), 3);
});

test("explicit model count wins, clamped to the pool and the hard cap", () => {
  assert.equal(teamUpProposerCount(POOL, "use 5 models for this"), 5);
  assert.equal(teamUpProposerCount(POOL, "ask 4 different models what they think"), 4);
  assert.equal(teamUpProposerCount(POOL, "compare 20 models on this"), TEAMUP_HARD_CAP);
  assert.equal(teamUpProposerCount(POOL, "use 2 models"), 2); // an explicit smaller count is honored too
});

test('"all models" / "every model" fans out to the full available pool (capped)', () => {
  assert.equal(teamUpProposerCount(POOL, "ask all models what they think"), Math.min(TEAMUP_HARD_CAP, POOL.length));
  assert.equal(teamUpProposerCount(POOL, "use every model"), Math.min(TEAMUP_HARD_CAP, POOL.length));
});

test("breadth/thoroughness language raises the count above 3 without an explicit number", () => {
  const n = teamUpProposerCount(POOL, "give me a second opinion and compare the pros and cons in depth");
  assert.ok(n > TEAMUP_MAX_MODELS, `expected more than ${TEAMUP_MAX_MODELS}, got ${n}`);
  assert.ok(n <= TEAMUP_HARD_CAP);
});

test("combined signals (long + multi-part + mixed-tag) stack toward the cap", () => {
  const codeAndMathTask =
    "Please solve this step by step and also write the equivalent function in code:\n" +
    "1. Derive the closed form\n2. Prove it converges\n3. Implement it\n4. Explain the algorithm's complexity\n" +
    "x".repeat(700);
  const n = teamUpProposerCount(POOL, codeAndMathTask);
  assert.ok(n >= TEAMUP_MAX_MODELS + 2, `expected strong stacking, got ${n}`);
  assert.ok(n <= TEAMUP_HARD_CAP);
});

test("vision-only pools are respected by the caller (eligiblePool filtering happens before this call)", () => {
  const visionOnly = POOL.filter((c) => c.slug === "openai" || c.slug === "gemini").map((c) => candidate(c.slug, true));
  assert.equal(teamUpProposerCount(visionOnly, "ask all models"), 2);
});
