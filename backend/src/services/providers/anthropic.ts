import { readSseStream } from "./sse-helpers.js";
import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { safeErrorMessage, splitSystemPrompt, toAnthropicStyleMessages } from "./types.js";

const BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
// Needed for the "document" content block (PDF attachments) — confirmed via ScaleMax's proxy
// that this header alone doesn't make a proxy forward the block if it doesn't support it, but
// the real Anthropic API does need it present to process a PDF at all.
const ANTHROPIC_BETA = "pdfs-2024-09-25";

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
    const { system, conversation } = splitSystemPrompt(messages);

    const res = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_BETA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        // Think mode is a prompted nudge, not native extended thinking — the model writes its
        // step-by-step reasoning as ordinary output text ahead of the final answer, so it shares
        // this same budget. At 2048 that reasoning (worse with long context) regularly ate the
        // whole budget and hit Anthropic's max_tokens stop_reason before any final answer came
        // out — indistinguishable from the reply randomly stopping mid-thought.
        max_tokens: 8192,
        system,
        messages: toAnthropicStyleMessages(conversation),
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

  async chatStream(apiKey, model, messages, onDelta, signal, _onThink, onUsage): Promise<string> {
    const { system, conversation } = splitSystemPrompt(messages);

    const res = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_BETA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system,
        stream: true,
        messages: toAnthropicStyleMessages(conversation),
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Anthropic chat failed: ${res.status} ${res.body ? await res.text() : ""}`);
    }

    let full = "";
    await readSseStream(res.body, (data) => {
      if (data.type === "message_delta") {
        const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        if (usage && onUsage) {
          onUsage({
            promptTokens: Number(usage.input_tokens ?? 0),
            completionTokens: Number(usage.output_tokens ?? 0),
            totalTokens: Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0),
          });
        }
        return;
      }
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
