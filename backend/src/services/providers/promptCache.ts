import type { TokenUsage } from "../tokenUsage.js";
import { toAnthropicStyleMessages, type ChatMessage } from "./types.js";

/**
 * Prompt caching, done once and shared.
 *
 * Providers cache a request's PREFIX. A cache hit skips re-processing that prefix — lower cost and a
 * faster first token — but only when the prefix is byte-identical to a recent request. So the whole
 * design is about making prefixes stable and telling Anthropic-format APIs where to cut:
 *
 *   [ stable system prompt ]  ← breakpoint 1 (same for every request of a given mode/persona)
 *   [ volatile system text  ]  ← search results / canvas artifact / attachment focus (never cached)
 *   [ conversation history  ]
 *   [ ...penultimate message ]  ← breakpoint 2
 *   [ latest message        ]  ← breakpoint 3 (rolling: next turn / next agent iteration reads it)
 *
 * The rolling last-message breakpoint is what makes agent loops (Build Mode re-sends a growing
 * transcript dozens of times) nearly free after the first call.
 */

type CacheControl = { type: "ephemeral" };
const EPHEMERAL: CacheControl = { type: "ephemeral" };

export type AnthropicSystemBlock = { type: "text"; text: string; cache_control?: CacheControl };

/** Splits system messages into a stable block and a volatile block, preserving order within each. */
export function splitSystemBlocks(messages: ChatMessage[]): { stable: string; volatile: string; conversation: ChatMessage[] } {
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
 * Builds the `system` + `messages` fields for an Anthropic-format /messages request (Anthropic and
 * ScaleMax) with cache breakpoints placed as described above. `enabled: false` produces the plain
 * uncached shape (used by tests and as an escape hatch via FRIDAY_PROMPT_CACHE=off).
 */
export function toAnthropicCachedRequest(messages: ChatMessage[], enabled = cachingEnabled()) {
  const { stable, volatile, conversation } = splitSystemBlocks(messages);
  const system: AnthropicSystemBlock[] = [];
  if (stable) system.push(enabled ? { type: "text", text: stable, cache_control: EPHEMERAL } : { type: "text", text: stable });
  if (volatile) system.push({ type: "text", text: volatile });

  // Normalise every message to the block-array form. Anthropic's cache keys on the exact serialised
  // content, and a message sent as a plain string on one turn but as a [{type:"text"}] array on the
  // next (because it happened to carry a breakpoint) does NOT match — measured live: turn 2 of a
  // conversation re-wrote the whole first message instead of reading it. One shape, always.
  let converted = (toAnthropicStyleMessages(conversation) as Record<string, unknown>[]).map((m) =>
    typeof m.content === "string" && m.content.trim() ? { ...m, content: [{ type: "text", text: m.content }] } : m,
  );
  if (enabled && converted.length > 0) {
    const last = converted.length - 1;
    converted = converted.slice();
    converted[last] = withBreakpoint(converted[last]!);
    // A second, earlier anchor guards against the previous turn's breakpoint drifting out of the
    // provider's ~20-block lookback window on long tool-heavy transcripts.
    if (last >= 2) converted[last - 1] = withBreakpoint(converted[last - 1]!);
  }
  return { system: system.length > 0 ? system : undefined, messages: converted };
}

export function cachingEnabled(): boolean {
  return (process.env.FRIDAY_PROMPT_CACHE ?? "on").toLowerCase() !== "off";
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
 * across providers), with the cached portions reported separately for cost/analytics.
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
      cachedTokens: this.read,
      cacheWriteTokens: this.write,
    };
  }
}
