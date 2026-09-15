import { readSseStream } from "./sse-helpers.js";
import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { safeErrorMessage, splitSystemPrompt } from "./types.js";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

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
    const { system, conversation } = splitSystemPrompt(messages);
    const contents = conversation.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const res = await fetch(
      `${BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
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

  async chatStream(apiKey, model, messages, onDelta, signal): Promise<string> {
    const { system, conversation } = splitSystemPrompt(messages);
    const contents = conversation.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const res = await fetch(
      `${BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        }),
        signal,
      },
    );
    if (!res.ok || !res.body) {
      throw new Error(`Gemini chat failed: ${res.status} ${res.body ? await res.text() : ""}`);
    }

    let full = "";
    await readSseStream(res.body, (data) => {
      const body = data as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (text) {
        full += text;
        onDelta(text);
      }
    });
    return full;
  },
};
