import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { safeErrorMessage } from "./types.js";

const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434";
const CLOUD_BASE_URL = "https://ollama.com";

// The admin panel's "key" field for Ollama accepts either:
//  - a local server URL (e.g. http://localhost:11434, or blank for the default), or
//  - an Ollama Cloud API key, used against https://ollama.com with a Bearer token.
interface OllamaTarget {
  baseUrl: string;
  headers: Record<string, string>;
}

function resolveTarget(apiKey: string): OllamaTarget {
  const trimmed = apiKey?.trim() ?? "";
  if (!trimmed) return { baseUrl: DEFAULT_LOCAL_BASE_URL, headers: {} };
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { baseUrl: trimmed.replace(/\/$/, ""), headers: {} };
  }
  return { baseUrl: CLOUD_BASE_URL, headers: { Authorization: `Bearer ${trimmed}` } };
}

export const ollamaAdapter: ProviderAdapter = {
  slug: "ollama",

  async listModels(apiKey: string): Promise<ProviderModel[]> {
    const { baseUrl, headers } = resolveTarget(apiKey);
    const res = await fetch(`${baseUrl}/api/tags`, { headers });
    if (!res.ok) throw new Error(`Ollama listModels failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { models: { name: string }[] };
    return body.models.map((m) => ({ modelId: m.name, displayName: m.name, capabilities: { chat: true } }));
  },

  async chat(apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
    const { baseUrl, headers } = resolveTarget(apiKey);
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
    });
    if (!res.ok) throw new Error(`Ollama chat failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { message: { content: string } };
    return body.message?.content ?? "";
  },

  async healthCheck(apiKey: string): Promise<HealthCheckResult> {
    try {
      const { baseUrl, headers } = resolveTarget(apiKey);
      const res = await fetch(`${baseUrl}/api/tags`, { headers });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  },
};
