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
      // /v1/user requires a "user_read" scope that a narrowly-scoped key (TTS/STT-only, which is
      // all Friday needs) won't have — /v1/models only needs basic read access and is what
      // listModels() already calls, so it's a truer check of "can this key do what we use it for."
      const res = await fetch(`${BASE_URL}/models`, { headers: { "xi-api-key": apiKey } });
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

export type VoiceOption = {
  voiceId: string;
  name: string;
  gender: "male" | "female" | "neutral";
  /** BCP-47-ish language tag the voice speaks in — drives which demo line gets read for it. */
  language: string;
  accent?: string;
  description?: string;
  previewUrl: string | null;
};

/** Lists selectable voices (the admin/user voice picker), each with a ready-made preview clip. */
export async function elevenlabsListVoices(apiKey: string): Promise<VoiceOption[]> {
  const res = await fetch(`${BASE_URL}/voices`, { headers: { "xi-api-key": apiKey } });
  if (!res.ok) throw new Error(`ElevenLabs listVoices failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    voices: {
      voice_id: string;
      name: string;
      labels?: { gender?: string; accent?: string; description?: string };
      preview_url?: string | null;
    }[];
  };

  return body.voices.map((v) => {
    const gender = v.labels?.gender;
    return {
      voiceId: v.voice_id,
      name: v.name.split(" - ")[0] ?? v.name,
      gender: gender === "male" || gender === "female" ? gender : "neutral",
      language: "en",
      accent: v.labels?.accent,
      description: v.labels?.description,
      previewUrl: v.preview_url ?? null,
    };
  });
}

/** Synthesizes speech for one line of text with the given voice, returning raw MP3 bytes. */
export async function elevenlabsSynthesize(apiKey: string, text: string, voiceId: string): Promise<Buffer> {
  const res = await fetch(`${BASE_URL}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
  });
  if (!res.ok) throw new Error(`ElevenLabs speech synthesis failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
