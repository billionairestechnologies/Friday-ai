import assert from "node:assert/strict";
import test from "node:test";
import { assertFetchableUrl, htmlToText, isBlockedAddress } from "../src/services/agent/safeFetch.js";
import { runToolLoop } from "../src/services/agent/toolLoop.js";
import type { FridayTool } from "../src/services/agent/tools/types.js";
import { gmailBodyText } from "../src/services/agent/tools/google.js";
import { memoriesToSystemPrompt, normalizeMemory } from "../src/services/memoryService.js";
import type { ProviderAdapter } from "../src/services/providers/types.js";
import type { ToolTurnResult } from "../src/services/providers/toolCalling.js";
import type { ChatCandidate } from "../src/services/providerService.js";

test("SSRF guard blocks private, loopback, link-local, metadata and mapped addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "142.250.1.1", "2606:4700:4700::1111"]) assert.equal(isBlockedAddress(ip), false, ip);
  for (const bad of ["file:///etc/passwd", "http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://metadata.internal/", "http://u:p@example.com/", "http://example.com:22/", "ftp://x.com"]) {
    assert.throws(() => assertFetchableUrl(bad), undefined, bad);
  }
  assert.equal(assertFetchableUrl("https://example.com/a?b=1").hostname, "example.com");
});

test("htmlToText keeps readable content and drops scripts/navigation", () => {
  const { title, text } = htmlToText(
    `<html><head><title>My &amp; Page</title><script>evil()</script></head><body><nav>menu</nav>` +
      `<h1>Hello</h1><p>First&nbsp;para with <a href="https://x.com/doc">a link</a>.</p><ul><li>one</li><li>two</li></ul><style>.a{}</style></body></html>`,
  );
  assert.equal(title, "My & Page");
  assert.match(text, /# Hello/);
  assert.match(text, /First para with a link \(https:\/\/x\.com\/doc\)/);
  assert.match(text, /- one\n- two/);
  assert.doesNotMatch(text, /evil|menu|\.a\{\}/);
});

test("gmailBodyText prefers text/plain and decodes base64url", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  assert.equal(
    gmailBodyText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<p>html</p>") } }, { mimeType: "text/plain", body: { data: b64("plain ✓") } }] }),
    "plain ✓",
  );
  assert.equal(gmailBodyText({ mimeType: "text/html", body: { data: b64("<p>only html</p>") } }), "only html");
});

test("memory prompt lists ids and keeps newest within budget", () => {
  assert.equal(memoriesToSystemPrompt([]), null);
  assert.equal(normalizeMemory("  likes   tea \n"), "likes tea");
  const prompt = memoriesToSystemPrompt([
    { id: "11111111-1111-1111-1111-111111111111", content: "Name is Asha", createdAt: "" },
    { id: "22222222-2222-2222-2222-222222222222", content: "Prefers Hindi", createdAt: "" },
  ])!;
  assert.match(prompt, /\[11111111-1111-1111-1111-111111111111\] Name is Asha/);
  const many = Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, content: "x".repeat(200), createdAt: "" }));
  const clipped = memoriesToSystemPrompt(many)!;
  assert.match(clipped, /id-99/);
  assert.doesNotMatch(clipped, /\[id-0\]/);
});

const CANDIDATE: ChatCandidate = { slug: "fake", providerDisplayName: "Fake", modelId: "m", displayName: "Fake", vision: false, minTier: "free" } as ChatCandidate;

function scriptedAdapter(turns: ToolTurnResult[], seen: unknown[][]): ProviderAdapter {
  let i = 0;
  return {
    slug: "fake",
    listModels: async () => [],
    chat: async () => "",
    healthCheck: async () => ({ ok: true }),
    async chatStreamWithTools(_key, _model, messages, opts, onDelta) {
      seen.push([...messages, { toolChoice: opts.toolChoice }]);
      const turn = turns[Math.min(i++, turns.length - 1)]!;
      if (turn.text) onDelta(turn.text);
      return turn;
    },
  };
}

test("tool loop runs tools in parallel, feeds results back, and finishes with text", async () => {
  const seen: unknown[][] = [];
  const adapter = scriptedAdapter(
    [
      { text: "Let me check.", toolCalls: [{ id: "a", name: "echo", args: { v: 1 } }, { id: "b", name: "boom", args: {} }], usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } },
      { text: "Answer: 1", toolCalls: [], usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 } },
    ],
    seen,
  );
  const echo: FridayTool = { spec: { name: "echo", description: "", parameters: { type: "object", properties: {} } }, label: () => "Echo", run: async (a) => `v=${a.v}` };
  const boom: FridayTool = { spec: { name: "boom", description: "", parameters: { type: "object", properties: {} } }, label: () => "Boom", run: async () => { throw new Error("kaput"); } };
  const steps: string[] = [];
  let streamed = "";
  const r = await runToolLoop({
    candidates: [CANDIDATE],
    history: [{ role: "user", content: "hi" }],
    tools: [echo, boom],
    ctx: { userId: "u", conversationId: "c" },
    onText: (d) => (streamed += d),
    onStep: (s) => steps.push(`${s.label}:${s.state}`),
    resolve: async () => ({ adapter, apiKey: "k" }),
  });
  assert.equal(r.candidate, CANDIDATE);
  assert.equal(r.text, "Let me check.\n\nAnswer: 1");
  assert.equal(streamed, r.text);
  assert.equal(r.toolCallCount, 2);
  assert.equal(r.usage.totalTokens, 19);
  assert.deepEqual(steps.filter((s) => !s.endsWith("running")).sort(), ["Boom:error", "Echo:ok"]);
  const second = seen[1]!;
  const toolMsgs = second.filter((m) => (m as { role?: string }).role === "tool") as { content: string }[];
  assert.deepEqual(toolMsgs.map((m) => m.content), ["v=1", "Error: kaput"]);
});

test("tool loop forces a text answer on the last round and falls back when nothing responds", async () => {
  const seen: unknown[][] = [];
  const looping = scriptedAdapter([{ text: "", toolCalls: [{ id: "x", name: "echo", args: {} }], usage: null }], seen);
  const echo: FridayTool = { spec: { name: "echo", description: "", parameters: { type: "object", properties: {} } }, label: () => "Echo", run: async () => "ok" };
  const r = await runToolLoop({
    candidates: [CANDIDATE],
    history: [{ role: "user", content: "hi" }],
    tools: [echo],
    ctx: { userId: "u", conversationId: "c" },
    onText: () => {},
    onStep: () => {},
    maxRounds: 3,
    resolve: async () => ({ adapter: looping, apiKey: "k" }),
  });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[2]!.at(-1), { toolChoice: "none" });
  assert.equal(r.toolCallCount, 2);

  const failing: ProviderAdapter = { ...looping, chatStreamWithTools: async () => { throw new Error("400 tools not supported"); } };
  const fb = await runToolLoop({
    candidates: [CANDIDATE],
    history: [{ role: "user", content: "hi" }],
    tools: [echo],
    ctx: { userId: "u", conversationId: "c" },
    onText: () => {},
    onStep: () => {},
    resolve: async () => ({ adapter: failing, apiKey: "k" }),
  });
  assert.equal(fb.candidate, null);
  assert.match(fb.error ?? "", /tools not supported/);
});

test("compactToolResults shortens the oldest tool results first until the budget fits", async () => {
  const { compactToolResults } = await import("../src/services/agent/toolLoop.js");
  const messages = [
    { role: "user" as const, content: "q" },
    { role: "tool" as const, toolCallId: "1", name: "fetch_url", content: "a".repeat(5000) },
    { role: "tool" as const, toolCallId: "2", name: "fetch_url", content: "b".repeat(5000) },
  ];
  compactToolResults(messages, 7000);
  assert.ok(messages[1]!.content.length < 2000, "oldest result shortened");
  assert.equal(messages[2]!.content.length, 5000, "newest result kept intact once under budget");
  assert.match(messages[1]!.content, /shortened/);
});

test("search snippets centre on the first matching term", async () => {
  const { snippetAround } = await import("../src/services/chat/searchAndShare.js");
  const text = `${"lorem ipsum ".repeat(40)}the Razorpay webhook signature failed ${"dolor sit ".repeat(40)}`;
  const snip = snippetAround(text, "razorpay webhook");
  assert.match(snip, /Razorpay webhook signature failed/);
  assert.ok(snip.startsWith("…") && snip.endsWith("…"));
  assert.equal(snippetAround("short text", "zzz"), "short text");
});

test("tool loop stops the moment the usage budget says the limit is reached", async () => {
  const seen: unknown[][] = [];
  const looping = scriptedAdapter([{ text: "Working.", toolCalls: [{ id: "x", name: "echo", args: {} }], usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 } }], seen);
  const echo: FridayTool = { spec: { name: "echo", description: "", parameters: { type: "object", properties: {} } }, label: () => "Echo", run: async () => "ok" };
  const totals: number[] = [];
  const r = await runToolLoop({
    candidates: [CANDIDATE],
    history: [{ role: "user", content: "hi" }],
    tools: [echo],
    ctx: { userId: "u", conversationId: "c" },
    onText: () => {},
    onStep: () => {},
    maxRounds: 10,
    budget: async (spent) => {
      totals.push(spent);
      return spent >= 2000 ? "You've reached your weekly usage limit, so I stopped here." : null;
    },
    resolve: async () => ({ adapter: looping, apiKey: "k" }),
  });
  // Round 1 is within budget (tools run), round 2 crosses it: no more tool calls, no third model call.
  assert.deepEqual(totals, [1000, 2000]);
  assert.equal(seen.length, 2);
  assert.equal(r.toolCallCount, 1);
  assert.match(r.text, /weekly usage limit/);
});
