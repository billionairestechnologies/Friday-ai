import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicUsageTracker, splitSystemBlocks, toAnthropicCachedRequest } from "../src/services/providers/promptCache.js";
import type { ChatMessage } from "../src/services/providers/types.js";
import { estimateCostCents, mergeTokenUsage } from "../src/services/tokenUsage.js";
import { invalidateMemoized, memoAsync } from "../src/utils/ttlMemo.js";
import { withSystemPreamble } from "../src/services/chat/promptContext.js";

const convo = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` }) as ChatMessage);

test("stable system block carries the breakpoint; volatile block is never cached", () => {
  const req = toAnthropicCachedRequest(
    [
      { role: "system", content: "STABLE A" },
      { role: "system", content: "SEARCH RESULTS", volatile: true },
      { role: "system", content: "STABLE B" },
      ...convo(1),
    ],
    true,
  );
  assert.equal(req.system?.length, 2);
  assert.equal(req.system![0]!.text, "STABLE A\n\nSTABLE B");
  assert.deepEqual(req.system![0]!.cache_control, { type: "ephemeral" });
  assert.equal(req.system![1]!.text, "SEARCH RESULTS");
  assert.equal(req.system![1]!.cache_control, undefined);
});

test("rolling breakpoint on the last message, plus an earlier anchor on longer transcripts", () => {
  const short = toAnthropicCachedRequest([{ role: "system", content: "S" }, ...convo(1)], true);
  assert.equal(JSON.stringify(short.messages).match(/cache_control/g)?.length, 1);

  const long = toAnthropicCachedRequest([{ role: "system", content: "S" }, ...convo(5)], true);
  const marked = (long.messages as { content: { cache_control?: unknown }[] }[]).map((m) => Array.isArray(m.content) && m.content.some((b) => b.cache_control));
  assert.deepEqual(marked, [false, false, false, true, true]);
});

test("caching disabled produces plain, breakpoint-free requests", () => {
  const req = toAnthropicCachedRequest([{ role: "system", content: "S" }, ...convo(4)], false);
  assert.doesNotMatch(JSON.stringify(req), /cache_control/);
});

test("empty trailing text is never given a breakpoint (Anthropic rejects empty text blocks)", () => {
  const req = toAnthropicCachedRequest([{ role: "system", content: "S" }, { role: "user", content: "" }], true);
  assert.doesNotMatch(JSON.stringify(req.messages), /cache_control/);
});

test("system blocks keep order and separate volatile content", () => {
  const { stable, volatile, conversation } = splitSystemBlocks([
    { role: "system", content: "1" },
    { role: "system", content: "v", volatile: true },
    { role: "system", content: "2" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(stable, "1\n\n2");
  assert.equal(volatile, "v");
  assert.equal(conversation.length, 1);
});

test("withSystemPreamble puts stable prompts first and per-turn context last, tagged volatile", () => {
  const out = withSystemPreamble(
    [{ role: "user", content: "hi" }],
    true,
    "be terse",
    true,
    [{ title: "t", url: "https://x.test", content: "snippet" }] as never,
    false,
    true,
  );
  const systems = out.filter((m) => m.role === "system");
  const firstVolatile = systems.findIndex((m) => m.volatile);
  assert.ok(firstVolatile > 0, "there should be volatile messages after stable ones");
  assert.ok(systems.slice(firstVolatile).every((m) => m.volatile), "nothing stable may follow a volatile message");
  assert.ok(systems.slice(0, firstVolatile).some((m) => m.content === "be terse"), "persona stays in the stable prefix");
});

test("Anthropic usage: prompt tokens include cache reads and writes; output is cumulative", () => {
  const t = new AnthropicUsageTracker();
  assert.equal(t.snapshot(), null);
  t.ingest({ input_tokens: 20, cache_read_input_tokens: 15000, cache_creation_input_tokens: 300, output_tokens: 1 });
  t.ingest({ output_tokens: 250 });
  assert.deepEqual(t.snapshot(), {
    promptTokens: 15320,
    completionTokens: 250,
    totalTokens: 15570,
    cachedTokens: 15000,
    cacheWriteTokens: 300,
  });
});

test("cost estimate discounts cached reads and surcharges cache writes", () => {
  const base = { promptTokens: 10_000, completionTokens: 0, totalTokens: 10_000 };
  const uncached = estimateCostCents("anthropic", base);
  const cached = estimateCostCents("anthropic", { ...base, cachedTokens: 9_000 });
  const written = estimateCostCents("anthropic", { ...base, cacheWriteTokens: 9_000 });
  assert.ok(cached < uncached * 0.25, `cached ${cached} should be far below uncached ${uncached}`);
  assert.ok(written > uncached, "cache writes cost a premium");
  assert.equal(mergeTokenUsage({ ...base, cachedTokens: 5 }, { ...base, cachedTokens: 7 }).cachedTokens, 12);
});

test("memoAsync: caches within TTL, single-flights, invalidates, and never caches failures", async () => {
  let calls = 0;
  const get = memoAsync(10_000, async (k: string) => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    if (k === "boom") throw new Error("nope");
    return `v:${k}`;
  });
  const [a, b] = await Promise.all([get("x"), get("x")]);
  assert.equal(a, "v:x");
  assert.equal(b, "v:x");
  assert.equal(calls, 1, "concurrent calls share one in-flight promise");
  await get("x");
  assert.equal(calls, 1, "second call is served from cache");
  invalidateMemoized();
  await get("x");
  assert.equal(calls, 2, "invalidation forces a refetch");
  await assert.rejects(get("boom"));
  await assert.rejects(get("boom"));
  assert.equal(calls, 4, "failures are not cached");
});

import { shouldProbeForLiveSearch } from "../src/services/chat/liveSearchIntent.js";

test("live-search probe is skipped for plain tasks but kept for anything that may need current data", () => {
  for (const skip of ["hi", "thanks!", "Explain what a mutex is", "write a poem about the sea", "Fix this bug:\n```js\nfoo()\n```", "translate 'good morning' to French"]) {
    assert.equal(shouldProbeForLiveSearch(skip), false, `should skip: ${skip}`);
  }
  for (const probe of ["what is nifty closing today", "Who won the match last night?", "latest iPhone price", "write about today's weather in Mumbai", "What is the capital of France?", "how much is bitcoin"]) {
    assert.equal(shouldProbeForLiveSearch(probe), true, `should probe: ${probe}`);
  }
});
