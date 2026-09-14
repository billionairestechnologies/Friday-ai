import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { safeErrorMessage } from "./types.js";

const DEFAULT_BASE_URL = "http://localhost:11434";

// Ollama runs locally and has no API key — the admin panel's "key" field is repurposed
// to hold the Ollama server's base URL (defaults to localhost:11434 if left blank).
function resolveBaseUrl(apiKey: string): string {
  return apiKey?.trim() || DEFAULT_BASE_URL;
}

export const ollamaAdapter: ProviderAdapter = {
  slug: "ollama",

  async listModels(apiKey: string): Promise<ProviderModel[]> {
    const res = await fetch(`${resolveBaseUrl(apiKey)}/api/tags`);
    if (!res.ok) throw new Error(`Ollama listModels failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { models: { name: string }[] };
    return body.models.map((m) => ({ modelId: m.name, displayName: m.name, capabilities: { chat: true } }));
  },

  async chat(apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
    const res = await fetch(`${resolveBaseUrl(apiKey)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
    });
    if (!res.ok) throw new Error(`Ollama chat failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { message: { content: string } };
    return body.message?.content ?? "";
  },

  async healthCheck(apiKey: string): Promise<HealthCheckResult> {
    try {
      const res = await fetch(`${resolveBaseUrl(apiKey)}/api/tags`);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  },
};
