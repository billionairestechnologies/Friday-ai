import { readSseStream } from "./sse-helpers.js";
import { usageFromGemini } from "../tokenUsage.js";
import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { base64PayloadOf, safeErrorMessage } from "./types.js";
import { streamGeminiToolTurn } from "./toolCalling.js";
import { splitSystemBlocks } from "./promptCache.js";

/**
 * Gemini's systemInstruction takes a `parts` array — this keeps the stable text (identical every
 * turn) as its own leading part and the volatile text (search results, canvas snapshot,
 * attachment focus) as a trailing part, instead of one joined string. Gemini 2.x's implicit
 * caching reuses the longest matching prefix of a request automatically (no explicit cache
 * config, unlike Anthropic), so keeping the stable text first and byte-identical maximises how
 * much of the request that implicit cache actually covers — this is a pure request-shape change,
 * `systemInstruction.parts` already accepted an array before this.
 */
function systemInstructionFor(stable: string, volatile: string): { parts: { text: string }[] } | undefined {
  const parts = [...(stable ? [{ text: stable }] : []), ...(volatile ? [{ text: volatile }] : [])];
  return parts.length > 0 ? { parts } : undefined;
}

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// Gemini's inline_data is mime-agnostic — this already handles PDFs (and anything else Gemini's
// API accepts inline) with no changes, unlike Anthropic/OpenAI which need a mime-specific block.
function toGeminiContents(conversation: ChatMessage[]) {
  return conversation.map((m) => {
    const fileParts = (m.images ?? []).map((img) => ({
      inline_data: { mime_type: img.mime, data: base64PayloadOf(img.dataUrl) },
    }));
    // Same reasoning as the Anthropic/OpenAI adapters: an empty text part alongside an
    // attachment (an image sent with no caption) shouldn't be sent as {text: ""}.
    const parts = m.content.trim() ? [{ text: m.content }, ...fileParts] : fileParts.length ? fileParts : [{ text: "" }];
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
}

export const geminiAdapter: ProviderAdapter = {
  slug: "gemini",

  async listModels(apiKey: string): Promise<ProviderModel[]> {
    const res = await fetch(`${BASE_URL}/models?key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) throw new Error(`Gemini listModels failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      models: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
    };

    return body.models
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => ({
        modelId: m.name.replace(/^models\//, ""),
        displayName: m.displayName ?? m.name,
        capabilities: { chat: true, vision: true },
      }));
  },

  async chat(apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
    const { stable, volatile, conversation } = splitSystemBlocks(messages);
    const contents = toGeminiContents(conversation);
    const systemInstruction = systemInstructionFor(stable, volatile);

    const res = await fetch(
      `${BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(systemInstruction ? { systemInstruction } : {}),
        }),
      },
    );
    if (!res.ok) throw new Error(`Gemini chat failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      candidates: { content: { parts: { text?: string }[] } }[];
    };
    return body.candidates[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  },

  async healthCheck(apiKey: string): Promise<HealthCheckResult> {
    try {
      const res = await fetch(`${BASE_URL}/models?key=${encodeURIComponent(apiKey)}`);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  },

  async chatStream(apiKey, model, messages, onDelta, signal, _onThink, onUsage): Promise<string> {
    const { stable, volatile, conversation } = splitSystemBlocks(messages);
    const contents = toGeminiContents(conversation);
    const systemInstruction = systemInstructionFor(stable, volatile);

    const res = await fetch(
      `${BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(systemInstruction ? { systemInstruction } : {}),
        }),
        signal,
      },
    );
    if (!res.ok || !res.body) {
      throw new Error(`Gemini chat failed: ${res.status} ${res.body ? await res.text() : ""}`);
    }

    let full = "";
    await readSseStream(res.body, (data) => {
      const body = data as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
          /** Gemini's IMPLICIT caching (2.x models, automatic — no explicit cache resource needed)
           *  reports the cached portion here. */
          cachedContentTokenCount?: number;
          /** Thinking tokens — billed as output but NOT included in candidatesTokenCount. */
          thoughtsTokenCount?: number;
        };
      };
      if (body.usageMetadata && onUsage) onUsage(usageFromGemini(body.usageMetadata));
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (text) {
        full += text;
        onDelta(text);
      }
    });
    return full;
  },

  async chatStreamWithTools(apiKey, model, messages, opts, onDelta) {
    return streamGeminiToolTurn(BASE_URL, apiKey, model, messages, opts, onDelta);
  },
};
