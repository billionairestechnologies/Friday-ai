import { createHash } from "node:crypto";
import type { TokenUsage } from "../tokenUsage.js";
import { toAnthropicStyleMessages, type ChatMessage } from "./types.js";

/**
 * Prompt caching, done once and shared.
 *
 * Providers cache a request's PREFIX. A cache hit skips re-processing that prefix — lower cost and
 * a faster first token — but only when the prefix is byte-identical to a recent request. So the
 * whole design is about making prefixes stable and telling each dialect where to cut:
 *
 *   [ stable system prompt  ]  ← breakpoint 1 (identical for every request of a given mode/toolset)
 *   [ volatile system text  ]  ← search results / canvas artifact / attachment focus (never cached)
 *   [ conversation history  ]
 *   [ ...penultimate message ]  ← breakpoint 2
 *   [ latest message        ]  ← breakpoint 3 (rolling: next turn / next agent iteration reads it)
 *
 * The rolling last-message breakpoint is what makes agent loops (the tool loop and Build Mode both
 * re-send a growing transcript, once per round/iteration) nearly free after the first call in a turn.
 *
 * Anthropic (and ScaleMax, which proxies its /messages API) needs explicit `cache_control`
 * breakpoints — that's what most of this file builds. OpenAI/OpenRouter cache automatically on any
 * stable-enough prefix; `promptCacheKey` just improves the odds of landing on the same cache shard.
 * Gemini's 2.x models cache implicitly too, given a stable-ordered `systemInstruction` — no request
 * shape change needed beyond what splitSystemBlocks already gives every dialect for free.
 */

type CacheControl = { type: "ephemeral" };
const EPHEMERAL: CacheControl = { type: "ephemeral" };

export type AnthropicSystemBlock = { type: "text"; text: string; cache_control?: CacheControl };

export function cachingEnabled(): boolean {
  return (process.env.FRIDAY_PROMPT_CACHE ?? "on").toLowerCase() !== "off";
}

/**
 * Splits system messages into a stable block and a volatile block, preserving order within each.
 * Generic over the message shape so it works both for a plain ChatMessage[] (the non-tool chat
 * path) and toolCalling.ts's wider AgentMessage[] (which also has assistant-tool-call and
 * tool-result variants that are simply excluded, same as any other non-system message).
 */
export function splitSystemBlocks<M extends { role: string; content: string; volatile?: boolean }>(
  messages: M[],
): { stable: string; volatile: string; conversation: M[] } {
  const stable: string[] = [];
  const volatile: string[] = [];
  for (const m of messages) {
    if (m.role !== "system") continue;
    (m.volatile ? volatile : stable).push(m.content);
  }
  return {
    stable: stable.join("\n\n"),
    volatile: volatile.join("\n\n"),
    conversation: messages.filter((m) => m.role !== "system"),
  };
}

/** The `system` blocks for an Anthropic-format request: stable text carries the cache breakpoint
 *  (when enabled and non-empty), volatile text follows uncached. Returns undefined when there's no
 *  system text at all, matching the plain (uncached) shape callers already expect. */
export function anthropicSystemBlocks(stable: string, volatile: string, enabled: boolean): AnthropicSystemBlock[] | undefined {
  const blocks: AnthropicSystemBlock[] = [];
  if (stable) blocks.push(enabled ? { type: "text", text: stable, cache_control: EPHEMERAL } : { type: "text", text: stable });
  if (volatile) blocks.push({ type: "text", text: volatile });
  return blocks.length > 0 ? blocks : undefined;
}

function withBreakpoint(message: Record<string, unknown>): Record<string, unknown> {
  const content = message.content;
  if (typeof content === "string") {
    if (!content.trim()) return message;
    return { ...message, content: [{ type: "text", text: content, cache_control: EPHEMERAL }] };
  }
  if (Array.isArray(content) && content.length > 0) {
    const blocks = content.slice() as Record<string, unknown>[];
    const last = blocks[blocks.length - 1]!;
    // Empty text blocks are invalid on Anthropic's API; only text/image/document blocks can carry a breakpoint.
    if (last.type === "text" && !String(last.text ?? "").trim()) return message;
    blocks[blocks.length - 1] = { ...last, cache_control: EPHEMERAL };
    return { ...message, content: blocks };
  }
  return message;
}

/**
 * Applies rolling cache breakpoints to an already-converted Anthropic-format messages array (the
 * output of toAnthropicStyleMessages/toAnthropicToolMessages — both `{role, content}` where content
 * is a string or a block array). Puts one on the last message, and — for a transcript long enough
 * that the previous turn's breakpoint might have drifted out of the provider's lookback window — a
 * second, earlier anchor two messages back. A no-op (returns the input unchanged) when disabled or
 * empty, so callers can call this unconditionally.
 */
export function withAnthropicCacheBreakpoints(messages: Record<string, unknown>[], enabled: boolean): Record<string, unknown>[] {
  if (!enabled || messages.length === 0) return messages;
  const out = messages.slice();
  const last = out.length - 1;
  out[last] = withBreakpoint(out[last]!);
  if (last >= 2) out[last - 1] = withBreakpoint(out[last - 1]!);
  return out;
}

/**
 * Builds the `system` + `messages` fields for an Anthropic-format /messages request (Anthropic and
 * ScaleMax, both plain chat and tool-calling) with cache breakpoints placed as described above.
 *
 * Anthropic's cache keys on the exact serialised content, and a message sent as a plain string on
 * one turn but as a `[{type:"text"}]` array on the next (because it happened to carry a breakpoint
 * on THAT turn) does NOT match — confirmed live: turn 2 of a conversation re-processed the whole
 * first message instead of reading it from cache. Every message is normalised to the block-array
 * form here, whether or not it ends up carrying a breakpoint, so the shape never depends on enabled.
 */
export function toAnthropicCachedRequest(
  messages: ChatMessage[],
  enabled: boolean = cachingEnabled(),
): { system: AnthropicSystemBlock[] | undefined; messages: Record<string, unknown>[] } {
  const { stable, volatile, conversation } = splitSystemBlocks(messages);
  const system = anthropicSystemBlocks(stable, volatile, enabled);
  const converted = (toAnthropicStyleMessages(conversation) as Record<string, unknown>[]).map((m) =>
    typeof m.content === "string" && m.content.trim() ? { ...m, content: [{ type: "text", text: m.content }] } : m,
  );
  return { system, messages: withAnthropicCacheBreakpoints(converted, enabled) };
}

/**
 * Deterministic key for OpenAI/OpenRouter's `prompt_cache_key` — a hint that increases the odds a
 * request lands on the same backend cache shard as a previous, prefix-identical one. Derived from
 * the stable system text (identical across every turn of the same conversation/mode/toolset), so no
 * new plumbing (conversation id, user id) needs to reach the adapters. Falls back to a constant when
 * there's no stable system text at all (still valid — just less selective).
 */
export function promptCacheKeyFor(stableSystemText: string): string {
  if (!stableSystemText) return "friday-default";
  return `friday-${createHash("sha256").update(stableSystemText).digest("hex").slice(0, 32)}`;
}

type AnthropicUsagePayload = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/**
 * Anthropic streams usage in two places: `message_start` (input + cache fields) and `message_delta`
 * (cumulative output tokens, sometimes repeating input fields). This merges them into one TokenUsage
 * whose promptTokens INCLUDES cached reads and cache writes (so quotas and displays stay comparable
 * across providers), with the cached portions reported separately for cost accounting.
 */
export class AnthropicUsageTracker {
  private input = 0;
  private read = 0;
  private write = 0;
  private output = 0;
  private seen = false;

  ingest(payload: AnthropicUsagePayload | undefined) {
    if (!payload) return;
    this.seen = true;
    if (payload.input_tokens != null) this.input = Number(payload.input_tokens);
    if (payload.cache_read_input_tokens != null) this.read = Number(payload.cache_read_input_tokens);
    if (payload.cache_creation_input_tokens != null) this.write = Number(payload.cache_creation_input_tokens);
    if (payload.output_tokens != null) this.output = Math.max(this.output, Number(payload.output_tokens));
  }

  snapshot(): TokenUsage | null {
    if (!this.seen) return null;
    const promptTokens = this.input + this.read + this.write;
    return {
      promptTokens,
      completionTokens: this.output,
      totalTokens: promptTokens + this.output,
      ...(this.read > 0 ? { cachedTokens: this.read } : {}),
      ...(this.write > 0 ? { cacheWriteTokens: this.write } : {}),
    };
  }
}
