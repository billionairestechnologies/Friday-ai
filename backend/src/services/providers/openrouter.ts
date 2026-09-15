import { streamOpenAiCompatibleChat } from "./sse-helpers.js";
import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { safeErrorMessage } from "./types.js";

const BASE_URL = "https://openrouter.ai/api/v1";

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
      body: JSON.stringify({ model, messages }),
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
      { model, messages },
      onDelta,
      signal,
      onThink,
    );
  },
};
