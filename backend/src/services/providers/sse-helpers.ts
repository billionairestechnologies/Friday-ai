import type { TokenUsage } from "../tokenUsage.js";

/**
 * Reads an SSE (`data: {...}\n\n`) response body, parsing each event's JSON payload and handing
 * it to `onEvent`. Stops on a `[DONE]` sentinel or stream end. Shared by every SSE-based provider
 * (OpenAI-compatible chat/completions, Anthropic messages, Gemini streamGenerateContent).
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (data: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
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
    if (chunk.usage && onUsage) {
      onUsage({
        promptTokens: Number(chunk.usage.prompt_tokens ?? 0),
        completionTokens: Number(chunk.usage.completion_tokens ?? 0),
        totalTokens: Number(
          chunk.usage.total_tokens ??
            Number(chunk.usage.prompt_tokens ?? 0) + Number(chunk.usage.completion_tokens ?? 0),
        ),
      });
    }
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
