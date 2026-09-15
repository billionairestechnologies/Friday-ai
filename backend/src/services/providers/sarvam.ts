import { streamOpenAiCompatibleChat } from "./sse-helpers.js";
import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { safeErrorMessage } from "./types.js";

const BASE_URL = "https://api.sarvam.ai";

// Sarvam AI has no public /models discovery endpoint at the time of writing, so we
// expose its known chat + speech models statically and verify the key with a live call.
const STATIC_MODELS: ProviderModel[] = [
  { modelId: "sarvam-105b", displayName: "Sarvam 105B (chat)", capabilities: { chat: true } },
  { modelId: "sarvam-105b-conversations", displayName: "Sarvam 105B Conversations (chat)", capabilities: { chat: true } },
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
      // sarvam-105b is a reasoning model that spends its token budget on a hidden
      // "reasoning_content" trace before writing the final answer, so it needs a
      // generous max_tokens or it can run out mid-thought and leave content null.
      body: JSON.stringify({ model, messages, max_tokens: 8192 }),
    });
    if (!res.ok) throw new Error(`Sarvam chat failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      choices: { message: { content: string | null; reasoning_content?: string | null } }[];
    };
    const message = body.choices[0]?.message;
    return message?.content ?? message?.reasoning_content ?? "";
  },

  async healthCheck(apiKey: string): Promise<HealthCheckResult> {
    try {
      const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "api-subscription-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "sarvam-105b", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, error: "Invalid API key" };
      return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  },

  async chatStream(apiKey, model, messages, onDelta, signal, onThink) {
    // Same generous budget as chat() — sarvam-105b burns tokens on a hidden reasoning trace first.
    return streamOpenAiCompatibleChat(
      `${BASE_URL}/v1/chat/completions`,
      { "api-subscription-key": apiKey },
      { model, messages, max_tokens: 8192 },
      onDelta,
      signal,
      onThink,
    );
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

export type SarvamVoiceOption = {
  voiceId: string;
  name: string;
  gender: "male" | "female";
  language: "hi" | "gu";
  languageLabel: string;
  languageCode: string;
  speaker: string;
};

// Curated Bulbul v3 speakers for Hindi and Gujarati — bulbul:v2 is deprecated, and its old
// speaker names (meera, arvind, ...) don't exist on v3, so both had to be verified live against
// the API. Sarvam's speakers aren't language-locked; the language comes from target_language_code.
export const SARVAM_VOICES: SarvamVoiceOption[] = [
  { voiceId: "sarvam:rahul:hi-IN", name: "Rahul", gender: "male", language: "hi", languageLabel: "Hindi", languageCode: "hi-IN", speaker: "rahul" },
  { voiceId: "sarvam:priya:hi-IN", name: "Priya", gender: "female", language: "hi", languageLabel: "Hindi", languageCode: "hi-IN", speaker: "priya" },
  { voiceId: "sarvam:rahul:gu-IN", name: "Rahul", gender: "male", language: "gu", languageLabel: "Gujarati", languageCode: "gu-IN", speaker: "rahul" },
  { voiceId: "sarvam:priya:gu-IN", name: "Priya", gender: "female", language: "gu", languageLabel: "Gujarati", languageCode: "gu-IN", speaker: "priya" },
];

/** Text-to-speech via Sarvam Bulbul v3, used for the Hindi/Gujarati voices and as an emergency
 *  fallback (English) when ElevenLabs has no working key. */
export async function sarvamSynthesize(
  apiKey: string,
  text: string,
  speaker = "priya",
  languageCode = "en-IN",
): Promise<Buffer> {
  const res = await fetch(`${BASE_URL}/text-to-speech`, {
    method: "POST",
    headers: { "api-subscription-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      inputs: [text],
      target_language_code: languageCode,
      speaker,
      model: "bulbul:v3",
    }),
  });
  if (!res.ok) throw new Error(`Sarvam speech synthesis failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { audios: string[] };
  const b64 = body.audios[0];
  if (!b64) throw new Error("Sarvam speech synthesis returned no audio");
  return Buffer.from(b64, "base64");
}
