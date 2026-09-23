import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { mergeSystemMessages, safeErrorMessage, toOllamaStyleMessages } from "./types.js";

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
      body: JSON.stringify({ model, messages: toOllamaStyleMessages(mergeSystemMessages(messages)), stream: false }),
    });
    if (!res.ok) throw new Error(`Ollama chat failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { message: { content: string } };
    return body.message?.content ?? "";
  },

  async chatStream(apiKey, model, messages, onDelta, signal, _onThink, onUsage): Promise<string> {
    const { baseUrl, headers } = resolveTarget(apiKey);
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: toOllamaStyleMessages(mergeSystemMessages(messages)), stream: true }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama chat failed: ${res.status} ${res.body ? await res.text() : ""}`);
    }

    // Ollama streams newline-delimited JSON objects, not SSE.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    let promptEvalCount = 0;
    let evalCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as {
            message?: { content?: string };
            done?: boolean;
            prompt_eval_count?: number;
            eval_count?: number;
          };
          const text = chunk.message?.content;
          if (text) {
            full += text;
            onDelta(text);
          }
          if (typeof chunk.prompt_eval_count === "number") promptEvalCount = chunk.prompt_eval_count;
          if (typeof chunk.eval_count === "number") evalCount = chunk.eval_count;
        } catch {
          /* skip malformed */
        }
      }
    }
    if (onUsage && (promptEvalCount > 0 || evalCount > 0)) {
      onUsage({
        promptTokens: promptEvalCount,
        completionTokens: evalCount,
        totalTokens: promptEvalCount + evalCount,
      });
    }
    return full;
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
