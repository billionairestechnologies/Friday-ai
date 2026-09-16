import { streamOpenAiCompatibleChat } from "./sse-helpers.js";
import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { mergeSystemMessages, safeErrorMessage, toOpenAiStyleMessages } from "./types.js";

const BASE_URL = "https://openrouter.ai/api/v1";

// OpenRouter defaults max_tokens to the model's full context window when omitted — for a 262K-
// context model that means every request needs credit headroom for a 131K-token reply even when
// the actual answer is a sentence. Confirmed in production: a request errored with 402 ("you
// requested up to 131072 tokens, but can only afford 82121") purely from this default, well
// before the account was actually out of credits. Capped like every other adapter.
const MAX_TOKENS = 8192;

export const openrouterAdapter: ProviderAdapter = {
  slug: "openrouter",

  async listModels(apiKey: string): Promise<ProviderModel[]> {
    const res = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`OpenRouter listModels failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data: { id: string; name?: string; architecture?: { modality?: string } }[] };

    return body.data.map((m) => ({
      modelId: m.id,
      displayName: m.name ?? m.id,
      capabilities: { chat: true, vision: m.architecture?.modality?.includes("image") ?? false },
    }));
  },

  async chat(apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, messages: toOpenAiStyleMessages(mergeSystemMessages(messages)) }),
    });
    if (!res.ok) throw new Error(`OpenRouter chat failed: ${res.status} ${await res.text()}`);
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

  async chatStream(apiKey, model, messages, onDelta, signal, onThink) {
    return streamOpenAiCompatibleChat(
      `${BASE_URL}/chat/completions`,
      { Authorization: `Bearer ${apiKey}` },
      { model, max_tokens: MAX_TOKENS, messages: toOpenAiStyleMessages(mergeSystemMessages(messages)) },
      onDelta,
      signal,
      onThink,
    );
  },
};
