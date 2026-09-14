import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { safeErrorMessage } from "./types.js";

const BASE_URL = "https://api.sarvam.ai";

// Sarvam AI has no public /models discovery endpoint at the time of writing, so we
// expose its known chat + speech models statically and verify the key with a live call.
const STATIC_MODELS: ProviderModel[] = [
  { modelId: "sarvam-m", displayName: "Sarvam-M (chat)", capabilities: { chat: true } },
  { modelId: "saarika:v2", displayName: "Saarika v2 (speech-to-text)", capabilities: { stt: true } },
  { modelId: "bulbul:v2", displayName: "Bulbul v2 (text-to-speech)", capabilities: { tts: true } },
];

export const sarvamAdapter: ProviderAdapter = {
  slug: "sarvam",

  async listModels(): Promise<ProviderModel[]> {
    return STATIC_MODELS;
  },

  async chat(apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "api-subscription-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages }),
    });
    if (!res.ok) throw new Error(`Sarvam chat failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    return body.choices[0]?.message?.content ?? "";
  },

  async healthCheck(apiKey: string): Promise<HealthCheckResult> {
    try {
      const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "api-subscription-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "sarvam-m", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, error: "Invalid API key" };
      return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  },
};

/** Speech-to-text via Sarvam Saarika, used as a fallback for the mic button. */
export async function sarvamTranscribe(apiKey: string, audio: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append("model", "saarika:v2");
  form.append("file", new Blob([new Uint8Array(audio)]), filename);

  const res = await fetch(`${BASE_URL}/speech-to-text`, {
    method: "POST",
    headers: { "api-subscription-key": apiKey },
    body: form,
  });
  if (!res.ok) throw new Error(`Sarvam transcription failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { transcript: string };
  return body.transcript;
}
