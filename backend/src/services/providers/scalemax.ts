import { readSseStream } from "./sse-helpers.js";
import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { safeErrorMessage, splitSystemPrompt } from "./types.js";

// ScaleMax (api.scalemax.pro) proxies Claude models behind an Anthropic-compatible
// /messages API, so this adapter mirrors the Anthropic one but targets ScaleMax's base
// URL and doesn't rely on a working GET /models (it exposes a fixed, known model set).
const BASE_URL = "https://api.scalemax.pro/token/v1";
const ANTHROPIC_VERSION = "2023-06-01";

const KNOWN_MODELS: ProviderModel[] = [
  { modelId: "claude-opus-5", displayName: "Claude Opus 5", capabilities: { chat: true, vision: true } },
  { modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5", capabilities: { chat: true, vision: true } },
  { modelId: "fable-5", displayName: "Claude Fable 5", capabilities: { chat: true, vision: true } },
];

export const scalemaxAdapter: ProviderAdapter = {
  slug: "scalemax",

  async listModels(_apiKey: string): Promise<ProviderModel[]> {
    return KNOWN_MODELS;
  },

  async chat(apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
    const { system, conversation } = splitSystemPrompt(messages);

    const res = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        // Same reasoning as anthropic.ts: Think mode's step-by-step text shares this budget, and
        // 2048 was cutting replies off mid-thought (Anthropic max_tokens stop_reason) well before
        // long-context/reasoning replies were done.
        max_tokens: 8192,
        system,
        messages: conversation.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) throw new Error(`ScaleMax chat failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { content: { type: string; text?: string }[] };
    return body.content.find((c) => c.type === "text")?.text ?? "";
  },

  async healthCheck(apiKey: string): Promise<HealthCheckResult> {
    try {
      const res = await fetch(`${BASE_URL}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: KNOWN_MODELS[0].modelId,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  },

  async chatStream(apiKey, model, messages, onDelta, signal): Promise<string> {
    const { system, conversation } = splitSystemPrompt(messages);

    const res = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system,
        stream: true,
        messages: conversation.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`ScaleMax chat failed: ${res.status} ${res.body ? await res.text() : ""}`);
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
