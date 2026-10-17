import { usageFromOpenAi, type TokenUsage } from "../tokenUsage.js";

/**
 * Reads an SSE (`data: {...}\n\n`) response body, parsing each event's JSON payload and handing
 * it to `onEvent`. Stops on a `[DONE]` sentinel or stream end. Shared by every SSE-based provider
 * (OpenAI-compatible chat/completions, Anthropic messages, Gemini streamGenerateContent).
 *
 * Idle watchdog: a provider that stalls mid-stream without closing the socket used to leave the
 * turn spinning forever ("Writing…" for minutes, nothing in the logs). No bytes for
 * STREAM_IDLE_MS now fails the read with a "stream stalled" error the callers already handle
 * (fall through to the next model, or end the turn with a friendly error). Anthropic pings every
 * few seconds and the others stream steadily, so the only legit long silence is a reasoning model
 * thinking — the default leaves ample room for that.
 */
export const STREAM_IDLE_MS = Math.max(15_000, Number(process.env.FRIDAY_STREAM_IDLE_MS) || 180_000);

export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (data: Record<string, unknown>) => void,
  idleMs: number = STREAM_IDLE_MS,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    let timer: NodeJS.Timeout | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`stream stalled: no data from the provider for ${Math.round(idleMs / 1000)}s`)), idleMs);
    });
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await Promise.race([reader.read(), idle]);
    } catch (err) {
      void reader.cancel().catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const { done, value } = chunk;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const data = part
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") continue;
      try {
        onEvent(JSON.parse(data) as Record<string, unknown>);
      } catch {
        /* skip malformed */
      }
    }
  }
}

type OpenAiCompatibleChunk = {
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** OpenAI's automatic prompt caching reports the cached portion here — no request-side
     *  config needed (unlike Anthropic's explicit cache_control breakpoints). Other OpenAI-
     *  compatible backends that don't cache simply omit this field. */
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};

/**
 * Streams a request against an OpenAI-compatible `/chat/completions` endpoint (OpenAI,
 * OpenRouter, Sarvam all speak this dialect), calling `onDelta` per `choices[0].delta.content`
 * chunk and resolving to the full accumulated text.
 *
 * Reasoning models (e.g. Sarvam's sarvam-105b) emit a separate `reasoning_content` field while
 * they "think" — that's routed to `onThink` (when given) instead of `onDelta` so it never gets
 * shown to the user as the actual answer. Without an `onThink`, reasoning is dropped rather than
 * silently mixed into the visible reply.
 */
export async function streamOpenAiCompatibleChat(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  onThink?: (text: string) => void,
  onUsage?: (usage: TokenUsage) => void,
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify((() => {
      const payload: Record<string, unknown> = { ...body, stream: true };
      if (!("stream_options" in body)) {
        payload.stream_options = { include_usage: true };
      } else if (body.stream_options == null) {
        delete payload.stream_options;
      }
      return payload;
    })()),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Streaming chat failed: ${res.status} ${res.body ? await res.text() : ""}`);
  }

  let full = "";
  let reasoningFull = "";
  await readSseStream(res.body, (data) => {
    const chunk = data as OpenAiCompatibleChunk;
    if (chunk.usage && onUsage) onUsage(usageFromOpenAi(chunk.usage));
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) {
      full += delta.content;
      onDelta(delta.content);
    } else if (delta?.reasoning_content) {
      reasoningFull += delta.reasoning_content;
      onThink?.(delta.reasoning_content);
    }
  });
  // Same gap the non-streaming chat() path guards against: a reasoning model (e.g. Sarvam's
  // sarvam-105b) can burn its whole token budget on reasoning_content and never emit a real
  // content delta. Fall back to the reasoning trace as the visible reply instead of an empty one.
  if (!full && reasoningFull) {
    full = reasoningFull;
    onDelta(reasoningFull);
  }
  return full;
}
