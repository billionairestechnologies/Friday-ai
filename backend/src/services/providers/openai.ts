import { streamOpenAiCompatibleChat } from "./sse-helpers.js";
import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { mergeSystemMessages, safeErrorMessage, toOpenAiStyleMessages } from "./types.js";
import { streamOpenAiToolTurn } from "./toolCalling.js";
import { cachingEnabled, promptCacheKeyFor, splitSystemBlocks } from "./promptCache.js";

/** OpenAI caches automatically on a stable prefix — this key just nudges the request toward the
 *  same backend cache shard as a previous call with the same stable system text. */
function cacheKeyField(messages: ChatMessage[]): Record<string, unknown> {
  return cachingEnabled() ? { prompt_cache_key: promptCacheKeyFor(splitSystemBlocks(messages).stable) } : {};
}

const BASE_URL = "https://api.openai.com/v1";

// Non-chat model families we don't want cluttering the chat model picker.
const EXCLUDE_PATTERNS = [/embedding/, /whisper/, /tts/, /moderation/, /^dall-e/, /^davinci/, /^babbage/];

export const openaiAdapter: ProviderAdapter = {
  slug: "openai",

  async listModels(apiKey: string): Promise<ProviderModel[]> {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenAI listModels failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data: { id: string }[] };

    return body.data
      .filter((m) => !EXCLUDE_PATTERNS.some((re) => re.test(m.id)))
      .map((m) => ({
        modelId: m.id,
        displayName: m.id,
        capabilities: { chat: true, vision: /gpt-4|gpt-5|omni|o[0-9]/.test(m.id) },
      }));
  },

  async chat(apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: toOpenAiStyleMessages(mergeSystemMessages(messages)), ...cacheKeyField(messages) }),
    });
    if (!res.ok) throw new Error(`OpenAI chat failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    return body.choices[0]?.message?.content ?? "";
  },

  async healthCheck(apiKey: string): Promise<HealthCheckResult> {
    try {
      const res = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  },

  async chatStream(apiKey, model, messages, onDelta, signal, onThink, onUsage) {
    return streamOpenAiCompatibleChat(
      `${BASE_URL}/chat/completions`,
      { Authorization: `Bearer ${apiKey}` },
      { model, messages: toOpenAiStyleMessages(mergeSystemMessages(messages)), ...cacheKeyField(messages) },
      onDelta,
      signal,
      onThink,
      onUsage,
    );
  },

  async chatStreamWithTools(apiKey, model, messages, opts, onDelta) {
    return streamOpenAiToolTurn(`${BASE_URL}/chat/completions`, { Authorization: `Bearer ${apiKey}` }, model, messages, opts, onDelta);
  },
};

/** Speech-to-text via OpenAI Whisper, used as a fallback for the mic button. */
export async function openaiTranscribe(apiKey: string, audio: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([new Uint8Array(audio)]), filename);

  const res = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI transcription failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { text: string };
  return body.text;
}
