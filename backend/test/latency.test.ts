import assert from "node:assert/strict";
import test from "node:test";
import { invalidateMemoized, memoAsync } from "../src/utils/ttlMemo.js";
import { shouldProbeForLiveSearch } from "../src/services/chat/liveSearchIntent.js";
import { streamWithHedging } from "../src/services/chat/hedgedStream.js";
import type { ProviderAdapter } from "../src/services/providers/types.js";

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

test("live-search probe is skipped for plain tasks but kept for anything that may need current data", () => {
  for (const skip of ["hi", "thanks!", "and a semaphore?", "why is that?", "Explain what a mutex is", "write a poem about the sea", "Fix this bug:\n```js\nfoo()\n```", "translate 'good morning' to French"]) {
    assert.equal(shouldProbeForLiveSearch(skip), false, `should skip: ${skip}`);
  }
  for (const probe of ["what is nifty closing today", "Who won the match last night?", "latest iPhone price", "write about today's weather in Mumbai", "What is the capital of France?", "how much is bitcoin"]) {
    assert.equal(shouldProbeForLiveSearch(probe), true, `should probe: ${probe}`);
  }
});

const cand = (slug: string) => ({ slug, providerDisplayName: slug, modelId: slug, displayName: slug, vision: false, minTier: "free" as const });
/** A fake streaming provider: waits `delayMs`, then emits `text` (or throws when `fail` is set). */
function fake(slug: string, opts: { delayMs: number; text?: string; fail?: string; onAbort?: () => void }): ProviderAdapter {
  return {
    slug,
    listModels: async () => [],
    chat: async () => "",
    healthCheck: async () => ({ ok: true }),
    chatStream: async (_k, _m, _msgs, onDelta, signal) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          opts.onAbort?.();
          reject(new Error("aborted"));
        });
      });
      if (opts.fail) throw new Error(opts.fail);
      onDelta(opts.text ?? slug);
      return opts.text ?? slug;
    },
  };
}
const run = (adapters: Record<string, ProviderAdapter>, order: string[], hedgeAfterMs: number) => {
  const out: string[] = [];
  return streamWithHedging({
    candidates: order.map(cand),
    history: [],
    hedgeAfterMs,
    onText: (d) => out.push(d),
    onThink: () => {},
    deps: { getAdapter: (s) => adapters[s]!, getKey: async () => "k" },
  }).then((r) => ({ r, out }));
};

test("hedging: a fast first candidate wins and the second is never started", async () => {
  let secondStarted = false;
  const { r, out } = await run({ a: fake("a", { delayMs: 10 }), b: { ...fake("b", { delayMs: 10 }), chatStream: async () => { secondStarted = true; return "b"; } } }, ["a", "b"], 300);
  assert.equal(r.candidate?.slug, "a");
  assert.deepEqual(out, ["a"]);
  assert.equal(r.hedged, false);
  assert.equal(secondStarted, false);
});

test("hedging: a slow first candidate is raced by the next; only the winner's text is forwarded and the loser is aborted", async () => {
  let aborted = false;
  const { r, out } = await run({ slow: fake("slow", { delayMs: 800, onAbort: () => (aborted = true) }), fast: fake("fast", { delayMs: 20 }) }, ["slow", "fast"], 100);
  assert.equal(r.candidate?.slug, "fast");
  assert.deepEqual(out, ["fast"]);
  assert.equal(r.hedged, true);
  assert.equal(aborted, true, "the losing attempt must be cancelled");
  // Both calls reach the usage ledger: the winner (charged) and the aborted loser (recorded, not charged).
  assert.deepEqual(r.attempts.map((a) => [a.candidate.slug, a.status, a.won]).sort(), [["fast", "ok", true], ["slow", "aborted", false]]);
});

test("failover: a candidate that errors before output hands over to the next", async () => {
  const { r, out } = await run({ bad: fake("bad", { delayMs: 5, fail: "bad: 500" }), ok: fake("ok", { delayMs: 5 }) }, ["bad", "ok"], 0);
  assert.equal(r.candidate?.slug, "ok");
  assert.deepEqual(out, ["ok"]);
  assert.deepEqual(r.attempts.map((a) => [a.status, a.outputChars]), [["failed", 0], ["ok", 2]]);
});

test("all candidates failing reports the last error and no winner", async () => {
  const { r, out } = await run({ x: fake("x", { delayMs: 5, fail: "x: down" }), y: fake("y", { delayMs: 5, fail: "y: down" }) }, ["x", "y"], 50);
  assert.equal(r.candidate, null);
  assert.match(r.lastError ?? "", /down/);
  assert.deepEqual(out, []);
});
