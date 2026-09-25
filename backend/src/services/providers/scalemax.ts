import { readSseStream } from "./sse-helpers.js";
import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { AnthropicUsageTracker, toAnthropicCachedRequest } from "./promptCache.js";
import { safeErrorMessage } from "./types.js";

// ScaleMax (api.scalemax.pro) proxies Claude AND GPT models (confirmed directly against the
// real API 2026-09-18 — its catalog grew well past the Claude-only set this adapter used to
// hardcode) behind one Anthropic-compatible /messages API, so chat/chatStream/healthCheck below
// work unmodified for any model id in the catalog. GET /models IS real and live (the comment this
// replaced claimed otherwise) — it just doesn't follow OpenAI's /v1/models shape, hence the
// bespoke response type here instead of reusing openai.ts's.
const BASE_URL = "https://api.scalemax.pro/token/v1";
const ANTHROPIC_VERSION = "2023-06-01";

// ScaleMax's catalog includes image-generation models (flux-*, gpt-image-*) alongside chat
// models, on the same /models list. This app has no image-generation feature to route them to —
// they'd otherwise show up in the chat model picker and fail on the first real message.
const IMAGE_MODEL_PATTERN = /^(flux-|gpt-image-)/;

type ScaleMaxModel = {
  id: string;
  display_name?: string;
  capabilities?: Record<string, boolean>;
};

export const scalemaxAdapter: ProviderAdapter = {
  slug: "scalemax",

  async listModels(apiKey: string): Promise<ProviderModel[]> {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
    });
    if (!res.ok) throw new Error(`ScaleMax listModels failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data: ScaleMaxModel[] };

    return body.data
      .filter((m) => !IMAGE_MODEL_PATTERN.test(m.id) && m.capabilities?.chat !== false)
      .map((m) => ({
        modelId: m.id,
        displayName: m.display_name ?? m.id,
        // ScaleMax's /models response doesn't report vision support explicitly — every model
        // in its chat catalog is a frontier multimodal-class release (Claude Opus/Sonnet/Fable,
        // GPT-5.x/6), so defaulting true here matches openai.ts's own generous precedent
        // (`/gpt-4|gpt-5|omni|o[0-9]/`) rather than under-claiming and blocking image attachments
        // on models that do support them.
        capabilities: { chat: true, vision: true },
      }));
  },

  async chat(apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
    const { system, messages: requestMessages } = toAnthropicCachedRequest(messages);

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
        messages: requestMessages,
      }),
    });
    if (!res.ok) throw new Error(`ScaleMax chat failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { content: { type: string; text?: string }[] };
    return body.content.find((c) => c.type === "text")?.text ?? "";
  },

  async healthCheck(apiKey: string): Promise<HealthCheckResult> {
    try {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  },

  async chatStream(apiKey, model, messages, onDelta, signal, _onThink, onUsage): Promise<string> {
    const { system, messages: requestMessages } = toAnthropicCachedRequest(messages);

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
        messages: requestMessages,
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`ScaleMax chat failed: ${res.status} ${res.body ? await res.text() : ""}`);
    }

    let full = "";
    // input + cache fields arrive on message_start, cumulative output on message_delta — merge both so
    // cached-token counts (and the real input size) aren't lost.
    const usageTracker = new AnthropicUsageTracker();
    await readSseStream(res.body, (data) => {
      if (data.type === "message_start") {
        usageTracker.ingest((data.message as { usage?: Record<string, number> } | undefined)?.usage);
        return;
      }
      if (data.type === "message_delta") {
        usageTracker.ingest(data.usage as Record<string, number> | undefined);
        const snapshot = usageTracker.snapshot();
        if (snapshot && onUsage) onUsage(snapshot);
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
