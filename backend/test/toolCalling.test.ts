import assert from "node:assert/strict";
import test from "node:test";
import {
  streamAnthropicToolTurn,
  streamGeminiToolTurn,
  streamOpenAiToolTurn,
  toAnthropicToolMessages,
  toGeminiToolContents,
  toOpenAiToolMessages,
  type AgentMessage,
  type ToolSpec,
} from "../src/services/providers/toolCalling.js";

const TOOLS: ToolSpec[] = [
  { name: "web_search", description: "search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];

/** Replaces global fetch with one that streams the given SSE events and records the request body. */
function mockSse(events: unknown[]): { bodies: Record<string, unknown>[]; restore: () => void } {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(text);
    // Split mid-event to prove the SSE reader reassembles chunk boundaries.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const mid = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  return { bodies, restore: () => void (globalThis.fetch = original) };
}

const CONVERSATION: AgentMessage[] = [
  { role: "system", content: "sys A" },
  { role: "system", content: "sys B" },
  { role: "user", content: "weather in Pune?" },
  {
    role: "assistant",
    content: "Checking.",
    toolCalls: [
      { id: "c1", name: "web_search", args: { query: "pune weather" } },
      { id: "c2", name: "web_search", args: { query: "pune forecast" }, signature: "sig-1" },
    ],
  },
  { role: "tool", toolCallId: "c1", name: "web_search", content: "30C" },
  { role: "tool", toolCallId: "c2", name: "web_search", content: "rain" },
];

test("OpenAI dialect: accumulates streamed tool-call fragments by index and sends tools", async () => {
  const mock = mockSse([
    { choices: [{ delta: { content: "Let me " } }] },
    { choices: [{ delta: { content: "look." } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "web_", arguments: '{"que' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "search", arguments: 'ry":"x"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "web_search", arguments: '{"query":"y"}' } }] } }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);
  try {
    const deltas: string[] = [];
    const r = await streamOpenAiToolTurn("https://x/v1/chat/completions", {}, "gpt", CONVERSATION, { tools: TOOLS }, (d) => deltas.push(d));
    assert.equal(r.text, "Let me look.");
    assert.deepEqual(deltas, ["Let me ", "look."]);
    assert.deepEqual(r.toolCalls, [
      { id: "call_a", name: "web_search", args: { query: "x" } },
      { id: "call_b", name: "web_search", args: { query: "y" } },
    ]);
    assert.deepEqual(r.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    const body = mock.bodies[0]!;
    assert.equal((body.tools as unknown[]).length, 1);
    assert.equal(body.tool_choice, "auto");
  } finally {
    mock.restore();
  }
});

test("OpenAI dialect: history carries assistant tool_calls and tool results; system merged", () => {
  const msgs = toOpenAiToolMessages(CONVERSATION);
  assert.deepEqual(msgs[0], { role: "system", content: "sys A\n\nsys B" });
  assert.equal(msgs[2]!.role, "assistant");
  assert.equal((msgs[2]!.tool_calls as { function: { arguments: string } }[])[0]!.function.arguments, '{"query":"pune weather"}');
  assert.deepEqual(msgs[3], { role: "tool", tool_call_id: "c1", content: "30C" });
  assert.equal(msgs.length, 5);
});

test("Anthropic dialect: parses tool_use + input_json_delta and usage; parallel results share one user message", async () => {
  const mock = mockSse([
    { type: "message_start", message: { usage: { input_tokens: 42 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Searching." } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "web_search", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"mumbai"}' } },
    { type: "message_delta", usage: { output_tokens: 7 } },
  ]);
  try {
    const r = await streamAnthropicToolTurn("https://x/v1/messages", {}, "claude", CONVERSATION, { tools: TOOLS, toolChoice: "none" }, () => {});
    assert.equal(r.text, "Searching.");
    assert.deepEqual(r.toolCalls, [{ id: "toolu_1", name: "web_search", args: { query: "mumbai" } }]);
    assert.deepEqual(r.usage, { promptTokens: 42, completionTokens: 7, totalTokens: 49 });
    const body = mock.bodies[0]!;
    assert.equal(body.system, "sys A\n\nsys B");
    assert.deepEqual(body.tool_choice, { type: "none" });
    assert.equal((body.tools as { input_schema: unknown }[])[0]!.input_schema !== undefined, true);
  } finally {
    mock.restore();
  }
  const msgs = toAnthropicToolMessages(CONVERSATION);
  assert.equal(msgs.length, 3);
  const results = msgs[2]!.content as { type: string; tool_use_id: string }[];
  assert.deepEqual(results.map((b) => b.tool_use_id), ["c1", "c2"]);
  const assistant = msgs[1]!.content as { type: string }[];
  assert.deepEqual(assistant.map((b) => b.type), ["text", "tool_use", "tool_use"]);
});

test("Gemini dialect: functionCall parts become tool calls, thoughtSignature round-trips, thoughts are hidden", async () => {
  const mock = mockSse([
    { candidates: [{ content: { parts: [{ text: "hidden", thought: true }, { text: "Ok. " }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: "web_search", args: { query: "z" } }, thoughtSignature: "SIG" }] } }] },
    { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } },
  ]);
  try {
    const r = await streamGeminiToolTurn("https://g", "key", "gemini-pro", CONVERSATION, { tools: TOOLS }, () => {});
    assert.equal(r.text, "Ok. ");
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0]!.signature, "SIG");
    assert.deepEqual(r.toolCalls[0]!.args, { query: "z" });
    const body = mock.bodies[0]!;
    assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
  } finally {
    mock.restore();
  }
  const contents = toGeminiToolContents(CONVERSATION) as { role: string; parts: Record<string, unknown>[] }[];
  assert.equal(contents.length, 3);
  assert.equal(contents[1]!.role, "model");
  assert.equal(contents[1]!.parts[2]!.thoughtSignature, "sig-1");
  assert.equal(contents[2]!.parts.length, 2, "parallel function responses share one turn");
});
