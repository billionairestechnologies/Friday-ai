import { readSseStream } from "./sse-helpers.js";
import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { safeErrorMessage } from "./types.js";

const BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

export const anthropicAdapter: ProviderAdapter = {
  slug: "anthropic",

  async listModels(apiKey: string): Promise<ProviderModel[]> {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
    });
    if (!res.ok) throw new Error(`Anthropic listModels failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data: { id: string; display_name?: string }[] };

    return body.data.map((m) => ({
      modelId: m.id,
      displayName: m.display_name ?? m.id,
      capabilities: { chat: true, vision: true },
    }));
  },

  async chat(apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
    const system = messages.find((m) => m.role === "system")?.content;
    const conversation = messages.filter((m) => m.role !== "system");

    const res = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system,
        messages: conversation.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic chat failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { content: { type: string; text?: string }[] };
    return body.content.find((c) => c.type === "text")?.text ?? "";
  },

  async healthCheck(apiKey: string): Promise<HealthCheckResult> {
    try {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  },

  async chatStream(apiKey, model, messages, onDelta, signal): Promise<string> {
    const system = messages.find((m) => m.role === "system")?.content;
    const conversation = messages.filter((m) => m.role !== "system");

    const res = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system,
        stream: true,
        messages: conversation.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Anthropic chat failed: ${res.status} ${res.body ? await res.text() : ""}`);
    }

    let full = "";
    await readSseStream(res.body, (data) => {
      if (data.type !== "content_block_delta") return;
      const delta = data.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && delta.text) {
        full += delta.text;
        onDelta(delta.text);
      }
    });
    return full;
  },
};
