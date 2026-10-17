import assert from "node:assert/strict";
import test from "node:test";
import { CUT_OFF_RESULT, runToolLoop } from "../src/services/agent/toolLoop.js";
import type { FridayTool } from "../src/services/agent/tools/types.js";
import { readSseStream } from "../src/services/providers/sse-helpers.js";
import type { BuildStep } from "../src/services/chat/types.js";
import type { ProviderAdapter } from "../src/services/providers/types.js";
import type { ChatCandidate } from "../src/services/providerService.js";

const CANDIDATE = { slug: "fake", providerDisplayName: "Fake", modelId: "m", displayName: "Fake", vision: false, minTier: "free" } as ChatCandidate;
const base = { slug: "fake", listModels: async () => [], chat: async () => "", healthCheck: async () => ({ ok: true }) } as unknown as ProviderAdapter;
const doc: FridayTool = { spec: { name: "create_document", description: "", parameters: { type: "object", properties: {} } }, label: (a) => `Created ${a.title}`, run: async () => "saved" };

test("a tool call gets a live row the moment it starts, and the call reuses that row", async () => {
  let round = 0;
  const adapter: ProviderAdapter = {
    ...base,
    async chatStreamWithTools(_k, _m, _msgs, opts) {
      if (round++ === 0) {
        opts.onToolStart?.("create_document");
        return { text: "", toolCalls: [{ id: "a", name: "create_document", args: { title: "Report" } }], usage: null };
      }
      return { text: "Done", toolCalls: [], usage: null };
    },
  };
  const events: BuildStep[] = [];
  const r = await runToolLoop({ candidates: [CANDIDATE], history: [{ role: "user", content: "hi" }], tools: [doc], ctx: { userId: "u", conversationId: "c" }, onText: () => {}, onStep: (s) => events.push(s), resolve: async () => ({ adapter, apiKey: "k" }) });
  assert.equal(new Set(events.map((e) => e.id)).size, 1, "one row, updated in place");
  assert.match(events[0]!.label, /Writing the document/);
  assert.deepEqual([events.at(-1)!.label, events.at(-1)!.state], ["Created Report", "ok"]);
  assert.equal(r.steps.length, 1);
});

test("a call cut off at the output limit is not run and the model is told to split it", async () => {
  let ran = 0;
  const tool: FridayTool = { ...doc, run: async () => { ran++; return "saved"; } };
  const seen: unknown[][] = [];
  let round = 0;
  const adapter: ProviderAdapter = {
    ...base,
    async chatStreamWithTools(_k, _m, msgs, opts) {
      seen.push([...msgs]);
      if (round++ === 0) {
        opts.onToolStart?.("create_document");
        return { text: "", toolCalls: [{ id: "a", name: "create_document", args: {}, incomplete: true }], usage: null };
      }
      return { text: "ok", toolCalls: [], usage: null };
    },
  };
  const events: BuildStep[] = [];
  await runToolLoop({ candidates: [CANDIDATE], history: [{ role: "user", content: "hi" }], tools: [tool], ctx: { userId: "u", conversationId: "c" }, onText: () => {}, onStep: (s) => events.push(s), resolve: async () => ({ adapter, apiKey: "k" }) });
  assert.equal(ran, 0);
  assert.equal(events.at(-1)!.state, "error");
  const toolMsg = (seen[1] as { role: string; content: string }[]).find((m) => m.role === "tool");
  assert.equal(toolMsg?.content, CUT_OFF_RESULT);
});

test("asks for 16k output, retries once at 8k when the model caps lower, and closes orphaned rows", async () => {
  const asked: (number | undefined)[] = [];
  const adapter: ProviderAdapter = {
    ...base,
    async chatStreamWithTools(_k, _m, _msgs, opts) {
      asked.push(opts.maxTokens);
      if (opts.maxTokens! > 8192) throw new Error("400 max_tokens: 16000 > 8192, which is the maximum allowed");
      return { text: "fine", toolCalls: [], usage: null };
    },
  };
  const r = await runToolLoop({ candidates: [CANDIDATE], history: [{ role: "user", content: "hi" }], tools: [doc], ctx: { userId: "u", conversationId: "c" }, onText: () => {}, onStep: () => {}, resolve: async () => ({ adapter, apiKey: "k" }) });
  assert.deepEqual(asked, [16000, 8192]);
  assert.equal(r.candidate, CANDIDATE);

  const dying: ProviderAdapter = {
    ...base,
    async chatStreamWithTools(_k, _m, _msgs, opts) {
      opts.onToolStart?.("create_document");
      throw new Error("socket hang up");
    },
  };
  const events: BuildStep[] = [];
  await runToolLoop({ candidates: [CANDIDATE], history: [{ role: "user", content: "hi" }], tools: [doc], ctx: { userId: "u", conversationId: "c" }, onText: () => {}, onStep: (s) => events.push(s), resolve: async () => ({ adapter: dying, apiKey: "k" }) });
  assert.deepEqual([events.at(-1)!.state, events.at(-1)!.detail], ["error", "Interrupted"]);
});

test("a provider stream that goes silent fails instead of hanging forever", async () => {
  const enc = new TextEncoder();
  const stalled = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('data: {"a":1}\n\n'));
      // ...and then nothing, never closed.
    },
  });
  const got: unknown[] = [];
  await assert.rejects(readSseStream(stalled, (d) => got.push(d), 50), /stream stalled/);
  assert.deepEqual(got, [{ a: 1 }]);
});
