import type { TokenUsage } from "../tokenUsage.js";
import { readSseStream } from "./sse-helpers.js";
import type { ChatMessage } from "./types.js";
import { base64PayloadOf, toAnthropicStyleMessages, toOpenAiStyleMessages } from "./types.js";
import { AnthropicUsageTracker, cachingEnabled, promptCacheKeyFor, splitSystemBlocks, withAnthropicCacheBreakpoints } from "./promptCache.js";

/**
 * Native (structured) tool calling, shared by every adapter whose API supports it. Three wire
 * dialects cover all of them: OpenAI-compatible chat/completions (OpenAI, OpenRouter), Anthropic
 * /messages (Anthropic, ScaleMax) and Gemini generateContent. Each turn streams visible text through
 * `onDelta` and resolves to the text plus any tool calls the model made; the caller (chat/toolLoop)
 * runs the tools and sends their results back as `tool` messages.
 */

/** JSON-Schema description of one tool. Keep `parameters` to the subset every dialect accepts:
 *  type/properties/required/description/enum/items (no `additionalProperties`, which Gemini rejects). */
export type ToolSpec = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Gemini's opaque thoughtSignature — must be echoed back on the functionCall part. */
  signature?: string;
};

export type AssistantToolMessage = { role: "assistant"; content: string; toolCalls: ToolCall[] };
export type ToolResultMessage = { role: "tool"; toolCallId: string; name: string; content: string };
export type AgentMessage = ChatMessage | AssistantToolMessage | ToolResultMessage;

export type ToolTurnOptions = {
  tools: ToolSpec[];
  /** "none" forces a final text answer (used on the last allowed round). */
  toolChoice?: "auto" | "none";
  signal?: AbortSignal;
  maxTokens?: number;
};

export type ToolTurnResult = { text: string; toolCalls: ToolCall[]; usage: TokenUsage | null };

function isToolResult(m: AgentMessage): m is ToolResultMessage {
  return m.role === "tool";
}

function isAssistantToolMessage(m: AgentMessage): m is AssistantToolMessage {
  return m.role === "assistant" && Array.isArray((m as AssistantToolMessage).toolCalls);
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function joinedSystem(messages: AgentMessage[]): string | undefined {
  const parts = messages.filter((m) => m.role === "system").map((m) => m.content);
  return parts.length ? parts.join("\n\n") : undefined;
}

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------------------------

export function toOpenAiToolMessages(messages: AgentMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const system = joinedSystem(messages);
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "system") continue;
    if (isToolResult(m)) {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else if (isAssistantToolMessage(m)) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
    } else {
      out.push(toOpenAiStyleMessages([m])[0]!);
    }
  }
  return out;
}

type OpenAiToolChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

export async function streamOpenAiToolTurn(
  url: string,
  headers: Record<string, string>,
  model: string,
  messages: AgentMessage[],
  opts: ToolTurnOptions,
  onDelta: (text: string) => void,
  extraBody: Record<string, unknown> = {},
): Promise<ToolTurnResult> {
  // OpenAI-compatible APIs cache automatically on a stable-enough prefix (no explicit breakpoint
  // needed); prompt_cache_key just improves the odds this request lands on the same cache shard as
  // the previous round of the same tool loop. A key derived from an empty system prefix (a request
  // with no system messages at all) is a harmless shared default, not a bug.
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiToolMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(cachingEnabled() ? { prompt_cache_key: promptCacheKeyFor(joinedSystem(messages) ?? "") } : {}),
    ...extraBody,
  };
  if (opts.tools.length) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = opts.toolChoice ?? "auto";
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(`Tool chat failed: ${res.status} ${res.body ? await res.text() : ""}`);

  let text = "";
  let usage: TokenUsage | null = null;
  const partial = new Map<number, { id: string; name: string; args: string }>();
  await readSseStream(res.body, (data) => {
    const chunk = data as OpenAiToolChunk;
    if (chunk.usage) {
      const promptTokens = Number(chunk.usage.prompt_tokens ?? 0);
      const completionTokens = Number(chunk.usage.completion_tokens ?? 0);
      const cachedTokens = Number(chunk.usage.prompt_tokens_details?.cached_tokens ?? 0);
      usage = {
        promptTokens,
        completionTokens,
        totalTokens: Number(chunk.usage.total_tokens ?? promptTokens + completionTokens),
        ...(cachedTokens > 0 ? { cachedTokens } : {}),
      };
    }
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) {
      text += delta.content;
      onDelta(delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const index = tc.index ?? 0;
      const current = partial.get(index) ?? { id: "", name: "", args: "" };
      if (tc.id) current.id = tc.id;
      if (tc.function?.name) current.name += tc.function.name;
      if (tc.function?.arguments) current.args += tc.function.arguments;
      partial.set(index, current);
    }
  });
  const toolCalls = [...partial.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, c]) => c.name)
    .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, args: parseArgs(c.args) }));
  return { text, toolCalls, usage };
}

// ---------------------------------------------------------------------------------------------
// Anthropic /messages (also ScaleMax)
// ---------------------------------------------------------------------------------------------

export function toAnthropicToolMessages(messages: AgentMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (isToolResult(m)) {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      // Results of one assistant turn's parallel calls go back together in ONE user message.
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content) && (prev.content as { type: string }[]).every((b) => b.type === "tool_result")) {
        (prev.content as unknown[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    } else if (isAssistantToolMessage(m)) {
      const blocks: Record<string, unknown>[] = [];
      if (m.content.trim()) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push(toAnthropicStyleMessages([m])[0]!);
    }
  }
  return out;
}

export async function streamAnthropicToolTurn(
  url: string,
  headers: Record<string, string>,
  model: string,
  messages: AgentMessage[],
  opts: ToolTurnOptions,
  onDelta: (text: string) => void,
  cacheEnabled: boolean = cachingEnabled(),
): Promise<ToolTurnResult> {
  // Same stable/volatile split as the plain chat path (promptCache.ts): the tool-use guidance and
  // every other stable system message get one cache breakpoint; the growing message history below
  // gets its own rolling breakpoint via withAnthropicCacheBreakpoints — the bigger win here, since
  // the tool loop resends this same, only-growing transcript once per round.
  const { stable, volatile } = splitSystemBlocks(messages);
  const system =
    stable || volatile
      ? [
          ...(stable ? [{ type: "text", text: stable, ...(cacheEnabled ? { cache_control: { type: "ephemeral" as const } } : {}) }] : []),
          ...(volatile ? [{ type: "text", text: volatile }] : []),
        ]
      : undefined;
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 8192,
    stream: true,
    messages: withAnthropicCacheBreakpoints(toAnthropicToolMessages(messages), cacheEnabled),
    ...(system ? { system } : {}),
  };
  if (opts.tools.length) {
    body.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    body.tool_choice = { type: opts.toolChoice === "none" ? "none" : "auto" };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(`Tool chat failed: ${res.status} ${res.body ? await res.text() : ""}`);

  let text = "";
  const tracker = new AnthropicUsageTracker();
  const blocks = new Map<number, { id: string; name: string; json: string }>();
  await readSseStream(res.body, (data) => {
    const type = data.type;
    if (type === "message_start") {
      tracker.ingest((data.message as { usage?: Record<string, unknown> } | undefined)?.usage);
    } else if (type === "message_delta") {
      tracker.ingest(data.usage as Record<string, unknown> | undefined);
    } else if (type === "content_block_start") {
      const block = data.content_block as { type?: string; id?: string; name?: string } | undefined;
      if (block?.type === "tool_use") blocks.set(Number(data.index ?? 0), { id: block.id ?? "", name: block.name ?? "", json: "" });
    } else if (type === "content_block_delta") {
      const delta = data.delta as { type?: string; text?: string; partial_json?: string } | undefined;
      if (delta?.type === "text_delta" && delta.text) {
        text += delta.text;
        onDelta(delta.text);
      } else if (delta?.type === "input_json_delta" && delta.partial_json) {
        const block = blocks.get(Number(data.index ?? 0));
        if (block) block.json += delta.partial_json;
      }
    }
  });
  const toolCalls = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, b]) => b.name)
    .map(([i, b]) => ({ id: b.id || `toolu_${i}`, name: b.name, args: parseArgs(b.json) }));
  return { text, toolCalls, usage: tracker.snapshot() };
}

// ---------------------------------------------------------------------------------------------
// Gemini generateContent
// ---------------------------------------------------------------------------------------------

export function toGeminiToolContents(messages: AgentMessage[]): Record<string, unknown>[] {
  const out: { role: string; parts: Record<string, unknown>[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (isToolResult(m)) {
      const part = { functionResponse: { name: m.name, response: { content: m.content } } };
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && prev.parts.every((p) => "functionResponse" in p)) prev.parts.push(part);
      else out.push({ role: "user", parts: [part] });
    } else if (isAssistantToolMessage(m)) {
      const parts: Record<string, unknown>[] = [];
      if (m.content.trim()) parts.push({ text: m.content });
      for (const c of m.toolCalls) {
        parts.push({ functionCall: { name: c.name, args: c.args }, ...(c.signature ? { thoughtSignature: c.signature } : {}) });
      }
      out.push({ role: "model", parts });
    } else {
      const fileParts = (m.images ?? []).map((img) => ({ inline_data: { mime_type: img.mime, data: base64PayloadOf(img.dataUrl) } }));
      const parts = m.content.trim() ? [{ text: m.content }, ...fileParts] : fileParts.length ? fileParts : [{ text: "" }];
      out.push({ role: m.role === "assistant" ? "model" : "user", parts });
    }
  }
  return out;
}

type GeminiToolChunk = {
  candidates?: {
    content?: {
      parts?: { text?: string; thought?: boolean; functionCall?: { name?: string; args?: Record<string, unknown>; id?: string }; thoughtSignature?: string }[];
    };
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; cachedContentTokenCount?: number };
};

export async function streamGeminiToolTurn(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: AgentMessage[],
  opts: ToolTurnOptions,
  onDelta: (text: string) => void,
): Promise<ToolTurnResult> {
  // Stable text (tool guidance, focus/honesty/format prompts) as its own leading part, volatile
  // text trailing — see gemini.ts's systemInstructionFor for why the split helps implicit caching.
  const { stable, volatile } = splitSystemBlocks(messages);
  const systemParts = [...(stable ? [{ text: stable }] : []), ...(volatile ? [{ text: volatile }] : [])];
  const body: Record<string, unknown> = {
    contents: toGeminiToolContents(messages),
    ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
  };
  if (opts.tools.length) {
    // Gemini rejects an OBJECT schema with empty `properties` — a no-argument tool omits `parameters`.
    body.tools = [
      {
        functionDeclarations: opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          ...(Object.keys(t.parameters.properties).length ? { parameters: t.parameters } : {}),
        })),
      },
    ];
    body.toolConfig = { functionCallingConfig: { mode: opts.toolChoice === "none" ? "NONE" : "AUTO" } };
  }
  const res = await fetch(
    `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: opts.signal },
  );
  if (!res.ok || !res.body) throw new Error(`Tool chat failed: ${res.status} ${res.body ? await res.text() : ""}`);

  let text = "";
  let usage: TokenUsage | null = null;
  const toolCalls: ToolCall[] = [];
  await readSseStream(res.body, (data) => {
    const chunk = data as GeminiToolChunk;
    if (chunk.usageMetadata) {
      const promptTokens = Number(chunk.usageMetadata.promptTokenCount ?? 0);
      const completionTokens = Number(chunk.usageMetadata.candidatesTokenCount ?? 0);
      const cachedTokens = Number(chunk.usageMetadata.cachedContentTokenCount ?? 0);
      usage = {
        promptTokens,
        completionTokens,
        totalTokens: Number(chunk.usageMetadata.totalTokenCount ?? promptTokens + completionTokens),
        ...(cachedTokens > 0 ? { cachedTokens } : {}),
      };
    }
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      if (part.functionCall?.name) {
        toolCalls.push({
          id: part.functionCall.id || `gcall_${toolCalls.length}`,
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
          ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
        });
      } else if (part.text && !part.thought) {
        text += part.text;
        onDelta(part.text);
      }
    }
  });
  return { text, toolCalls, usage };
}
