import type { ChatMessage, HealthCheckResult, ProviderAdapter, ProviderModel } from "./types.js";
import { safeErrorMessage } from "./types.js";

const BASE_URL = "https://api.elevenlabs.io/v1";

// ElevenLabs is voice-only in Friday AI (text-to-speech + the speech-to-text used by the mic button),
// it never appears in the text-chat model picker.
export const elevenlabsAdapter: ProviderAdapter = {
  slug: "elevenlabs",

  async listModels(apiKey: string): Promise<ProviderModel[]> {
    const res = await fetch(`${BASE_URL}/models`, { headers: { "xi-api-key": apiKey } });
    if (!res.ok) throw new Error(`ElevenLabs listModels failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      model_id: string;
      name: string;
      can_do_text_to_speech?: boolean;
      can_do_voice_conversion?: boolean;
    }[];

    return body.map((m) => ({
      modelId: m.model_id,
      displayName: m.name,
      capabilities: { tts: m.can_do_text_to_speech ?? true, stt: false },
    }));
  },

  async chat(): Promise<string> {
    throw new Error("ElevenLabs is a voice provider and does not support text chat");
  },

  async healthCheck(apiKey: string): Promise<HealthCheckResult> {
    try {
      const res = await fetch(`${BASE_URL}/user`, { headers: { "xi-api-key": apiKey } });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  },
};

/** Speech-to-text via ElevenLabs Scribe, used by the mic button (feature/voice). */
export async function elevenlabsTranscribe(apiKey: string, audio: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("file", new Blob([new Uint8Array(audio)]), filename);

  const res = await fetch(`${BASE_URL}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  if (!res.ok) throw new Error(`ElevenLabs transcription failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { text: string };
  return body.text;
}
