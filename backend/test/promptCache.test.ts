import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicUsageTracker,
  anthropicSystemBlocks,
  cachingEnabled,
  promptCacheKeyFor,
  splitSystemBlocks,
  toAnthropicCachedRequest,
  withAnthropicCacheBreakpoints,
} from "../src/services/providers/promptCache.js";
import { estimateCostCents } from "../src/services/tokenUsage.js";
import type { ChatMessage } from "../src/services/providers/types.js";

test("cachingEnabled honours FRIDAY_PROMPT_CACHE, defaulting to on", () => {
  const original = process.env.FRIDAY_PROMPT_CACHE;
  try {
    delete process.env.FRIDAY_PROMPT_CACHE;
    assert.equal(cachingEnabled(), true);
    process.env.FRIDAY_PROMPT_CACHE = "off";
    assert.equal(cachingEnabled(), false);
    process.env.FRIDAY_PROMPT_CACHE = "OFF";
    assert.equal(cachingEnabled(), false);
    process.env.FRIDAY_PROMPT_CACHE = "on";
    assert.equal(cachingEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.FRIDAY_PROMPT_CACHE;
    else process.env.FRIDAY_PROMPT_CACHE = original;
  }
});

test("splitSystemBlocks separates stable from volatile, preserving order within each, and keeps non-system messages intact", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "stable A" },
    { role: "system", content: "volatile A", volatile: true },
    { role: "system", content: "stable B" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  const { stable, volatile, conversation } = splitSystemBlocks(messages);
  assert.equal(stable, "stable A\n\nstable B");
  assert.equal(volatile, "volatile A");
  assert.deepEqual(conversation, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
});

test("splitSystemBlocks with no system messages at all", () => {
  const { stable, volatile, conversation } = splitSystemBlocks([{ role: "user", content: "hi" }]);
  assert.equal(stable, "");
  assert.equal(volatile, "");
  assert.equal(conversation.length, 1);
});

test("anthropicSystemBlocks: breakpoint only on stable, only when enabled and non-empty; undefined when nothing at all", () => {
  assert.deepEqual(anthropicSystemBlocks("stable", "volatile", true), [
    { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
    { type: "text", text: "volatile" },
  ]);
  assert.deepEqual(anthropicSystemBlocks("stable", "volatile", false), [
    { type: "text", text: "stable" },
    { type: "text", text: "volatile" },
  ]);
  assert.deepEqual(anthropicSystemBlocks("", "volatile only", true), [{ type: "text", text: "volatile only" }]);
  assert.equal(anthropicSystemBlocks("", "", true), undefined);
});

test("withAnthropicCacheBreakpoints: breakpoint on the last message, and a second anchor two back on a long enough transcript", () => {
  const short = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
  const withBp = withAnthropicCacheBreakpoints(short, true);
  assert.deepEqual(withBp[0], { role: "user", content: "a" }); // untouched — only 2 messages, no room for a second anchor
  assert.deepEqual(withBp[1], { role: "assistant", content: [{ type: "text", text: "b", cache_control: { type: "ephemeral" } }] });

  const long = [
    { role: "user", content: "1" },
    { role: "assistant", content: "2" },
    { role: "user", content: "3" },
    { role: "assistant", content: "4" },
  ];
  const withTwoBp = withAnthropicCacheBreakpoints(long, true);
  assert.deepEqual(withTwoBp[0], { role: "user", content: "1" }); // still untouched
  assert.deepEqual((withTwoBp[2] as { content: { cache_control?: unknown }[] }).content[0]!.cache_control, { type: "ephemeral" });
  assert.deepEqual((withTwoBp[3] as { content: { cache_control?: unknown }[] }).content[0]!.cache_control, { type: "ephemeral" });
});

test("withAnthropicCacheBreakpoints: no-op when disabled or empty; skips an empty trailing text block; handles block-array content", () => {
  const messages = [{ role: "user", content: "x" }];
  assert.deepEqual(withAnthropicCacheBreakpoints(messages, false), messages);
  assert.deepEqual(withAnthropicCacheBreakpoints([], true), []);

  // An image-only message (empty text) must never get a breakpoint on an empty text block — Anthropic rejects that.
  const imageOnly = [{ role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "" }] }];
  assert.deepEqual(withAnthropicCacheBreakpoints(imageOnly, true), imageOnly);

  // Non-empty block-array content DOES get the breakpoint, on its last block.
  const withText = [{ role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "describe this" }] }];
  const out = withAnthropicCacheBreakpoints(withText, true)[0] as { content: { cache_control?: unknown }[] };
  assert.equal(out.content.length, 2);
  assert.equal(out.content[0]!.cache_control, undefined);
  assert.deepEqual(out.content[1]!.cache_control, { type: "ephemeral" });
});

test("toAnthropicCachedRequest: normalises every message to block-array form regardless of enabled (cache-key shape stability)", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "be helpful" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ];
  const cached = toAnthropicCachedRequest(messages, true);
  const uncached = toAnthropicCachedRequest(messages, false);
  assert.deepEqual(cached.system, [{ type: "text", text: "be helpful", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(uncached.system, [{ type: "text", text: "be helpful" }]);
  // Every message is a block array either way — same shape whether or not it happens to carry a breakpoint.
  for (const set of [cached.messages, uncached.messages]) {
    for (const m of set) assert.ok(Array.isArray((m as { content: unknown }).content), JSON.stringify(m));
  }
  assert.deepEqual((uncached.messages[1] as { content: unknown }).content, [{ type: "text", text: "hi there" }]);
});

test("promptCacheKeyFor is deterministic, differs for different stable text, and has a shared fallback for empty text", () => {
  const a = promptCacheKeyFor("system prompt A");
  const b = promptCacheKeyFor("system prompt A");
  const c = promptCacheKeyFor("system prompt B");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^friday-[0-9a-f]{32}$/);
  assert.equal(promptCacheKeyFor(""), "friday-default");
});

test("AnthropicUsageTracker merges message_start + message_delta, keeps the max output_tokens seen, and returns null before any usage", () => {
  const tracker = new AnthropicUsageTracker();
  assert.equal(tracker.snapshot(), null);
  tracker.ingest({ input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 });
  tracker.ingest({ output_tokens: 5 });
  tracker.ingest({ output_tokens: 12 }); // cumulative — should win over the earlier smaller value
  const snap = tracker.snapshot()!;
  assert.equal(snap.promptTokens, 150); // 100 + 40 + 10
  assert.equal(snap.completionTokens, 12);
  assert.equal(snap.totalTokens, 162);
  assert.equal(snap.cachedTokens, 40);
  assert.equal(snap.cacheWriteTokens, 10);
});

test("AnthropicUsageTracker omits cache fields entirely when nothing was cached", () => {
  const tracker = new AnthropicUsageTracker();
  tracker.ingest({ input_tokens: 20, output_tokens: 3 });
  const snap = tracker.snapshot()!;
  assert.equal(snap.cachedTokens, undefined);
  assert.equal(snap.cacheWriteTokens, undefined);
});

test("cost accounting: a cache read is cheaper and a cache write pricier than the same tokens uncached (Anthropic)", () => {
  const plain = estimateCostCents("anthropic", { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 });
  const cachedRead = estimateCostCents("anthropic", { promptTokens: 1000, completionTokens: 0, totalTokens: 1000, cachedTokens: 1000 });
  const cacheWrite = estimateCostCents("anthropic", { promptTokens: 1000, completionTokens: 0, totalTokens: 1000, cacheWriteTokens: 1000 });
  assert.ok(cachedRead < plain, `expected a cache read to be cheaper: ${cachedRead} vs ${plain}`);
  assert.ok(cacheWrite > plain, `expected a cache write to cost more: ${cacheWrite} vs ${plain}`);
  assert.equal(Math.round((cachedRead / plain) * 100) / 100, 0.1);
  assert.equal(Math.round((cacheWrite / plain) * 100) / 100, 1.25);
});

test("cost accounting: providers that don't report cache fields are unaffected (cachedTokens/cacheWriteTokens default to 0)", () => {
  const withField = estimateCostCents("gemini", { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 });
  const withoutField = estimateCostCents("gemini", { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cachedTokens: 0 });
  assert.equal(withField, withoutField);
});
