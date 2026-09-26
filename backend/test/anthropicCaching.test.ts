import assert from "node:assert/strict";
import test from "node:test";
import { anthropicAdapter } from "../src/services/providers/anthropic.js";
import type { ChatMessage } from "../src/services/providers/types.js";

function mockSse(events: unknown[]): { bodies: Record<string, unknown>[]; restore: () => void } {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(new TextEncoder().encode(text), { status: 200 });
  }) as typeof fetch;
  return { bodies, restore: () => void (globalThis.fetch = original) };
}

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are Friday." },
  { role: "system", content: "A search just ran: results here", volatile: true },
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
  { role: "user", content: "what's the weather" },
];

test("anthropic.ts chatStream sends a cached request shape and reports cache usage end-to-end", async () => {
  const mock = mockSse([
    { type: "message_start", message: { usage: { input_tokens: 50, cache_read_input_tokens: 30 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "It's sunny." } },
    { type: "message_delta", usage: { output_tokens: 4 } },
  ]);
  let usage: unknown;
  try {
    const full = await anthropicAdapter.chatStream!("key", "claude-x", MESSAGES, () => {}, undefined, undefined, (u) => (usage = u));
    assert.equal(full, "It's sunny.");
    const body = mock.bodies[0]!;
    // Stable system text carries the breakpoint; volatile follows, uncached.
    assert.deepEqual(body.system, [
      { type: "text", text: "You are Friday.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "A search just ran: results here" },
    ]);
    const messages = body.messages as { role: string; content: { cache_control?: unknown }[] }[];
    assert.equal(messages.length, 3);
    // Rolling breakpoint on the last message and the one right before it (last-1); the earliest
    // message (index 0, out of the lookback window either way) is untouched.
    assert.deepEqual(messages[2]!.content[0]!.cache_control, { type: "ephemeral" });
    assert.deepEqual(messages[1]!.content[0]!.cache_control, { type: "ephemeral" });
    assert.equal(messages[0]!.content[0]!.cache_control, undefined);
    assert.deepEqual(usage, { promptTokens: 80, completionTokens: 4, totalTokens: 84, cachedTokens: 30 });
  } finally {
    mock.restore();
  }
});

test("anthropic.ts chatStream omits cache_control entirely when FRIDAY_PROMPT_CACHE=off", async () => {
  const original = process.env.FRIDAY_PROMPT_CACHE;
  process.env.FRIDAY_PROMPT_CACHE = "off";
  const mock = mockSse([{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }]);
  try {
    await anthropicAdapter.chatStream!("key", "claude-x", MESSAGES, () => {}, undefined, undefined, () => {});
    const body = JSON.stringify(mock.bodies[0]);
    assert.doesNotMatch(body, /cache_control/);
  } finally {
    mock.restore();
    if (original === undefined) delete process.env.FRIDAY_PROMPT_CACHE;
    else process.env.FRIDAY_PROMPT_CACHE = original;
  }
});
