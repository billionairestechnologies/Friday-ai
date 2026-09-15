import { HttpError } from "../middleware/errorHandler.js";
import { getWorkingKeyForProvider } from "./providerService.js";
import {
  elevenlabsListVoices,
  elevenlabsSynthesize,
  elevenlabsTranscribe,
  type VoiceOption,
} from "./providers/elevenlabs.js";
import { openaiTranscribe } from "./providers/openai.js";
import { SARVAM_VOICES, sarvamSynthesize, sarvamTranscribe } from "./providers/sarvam.js";

type TranscribeFn = (apiKey: string, audio: Buffer, filename: string) => Promise<string>;

// Tried in this order — the mic button uses whichever speech-to-text provider the admin
// has configured a working key for, so no frontend code needs to know which one it is.
const STT_PROVIDERS: { slug: string; transcribe: TranscribeFn }[] = [
  { slug: "elevenlabs", transcribe: elevenlabsTranscribe },
  { slug: "sarvam", transcribe: sarvamTranscribe },
  { slug: "openai", transcribe: openaiTranscribe },
];

export async function transcribeAudio(audio: Buffer, filename: string): Promise<{ text: string; provider: string }> {
  const errors: string[] = [];

  for (const { slug, transcribe } of STT_PROVIDERS) {
    try {
      const apiKey = await getWorkingKeyForProvider(slug);
      const text = await transcribe(apiKey, audio, filename);
      return { text, provider: slug };
    } catch (err) {
      errors.push(`${slug}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }

  throw new HttpError(503, `No speech-to-text provider available. ${errors.join("; ")}`);
}

/**
 * The voices selectable in the picker: ElevenLabs' named voices (if that key works) plus the
 * curated Hindi/Gujarati Sarvam voices (if that key works) — either provider missing just means
 * fewer voices offered, not a hard failure.
 */
export async function listVoices(): Promise<VoiceOption[]> {
  const [elevenVoices, sarvamOk] = await Promise.all([
    getWorkingKeyForProvider("elevenlabs")
      .then((apiKey) => elevenlabsListVoices(apiKey))
      .catch(() => [] as VoiceOption[]),
    getWorkingKeyForProvider("sarvam")
      .then(() => true)
      .catch(() => false),
  ]);

  const sarvamVoices: VoiceOption[] = sarvamOk
    ? SARVAM_VOICES.map((v) => ({
        voiceId: v.voiceId,
        name: v.name,
        gender: v.gender,
        language: v.language,
        accent: v.languageLabel,
        previewUrl: null,
      }))
    : [];

  return [...elevenVoices, ...sarvamVoices];
}

function parseSarvamVoiceId(voiceId: string) {
  const match = SARVAM_VOICES.find((v) => v.voiceId === voiceId);
  return match ?? null;
}

/**
 * Synthesizes speech for one line. A Hindi/Gujarati voice (voiceId prefixed `sarvam:`) always
 * goes to Sarvam, since that's the only provider that speaks those languages. Otherwise prefers
 * the user's chosen ElevenLabs voice, falling back to Sarvam's default English voice if
 * ElevenLabs has no working key.
 */
export async function synthesizeSpeech(text: string, voiceId?: string): Promise<{ audio: Buffer; mime: string }> {
  const sarvamVoice = voiceId ? parseSarvamVoiceId(voiceId) : null;
  if (sarvamVoice) {
    const apiKey = await getWorkingKeyForProvider("sarvam");
    const audio = await sarvamSynthesize(apiKey, text, sarvamVoice.speaker, sarvamVoice.languageCode);
    return { audio, mime: "audio/wav" };
  }

  try {
    const apiKey = await getWorkingKeyForProvider("elevenlabs");
    const audio = await elevenlabsSynthesize(apiKey, text, voiceId || "EXAVITQu4vr4xnSDxMaL");
    return { audio, mime: "audio/mpeg" };
  } catch (elevenErr) {
    try {
      const apiKey = await getWorkingKeyForProvider("sarvam");
      const audio = await sarvamSynthesize(apiKey, text);
      return { audio, mime: "audio/wav" };
    } catch (sarvamErr) {
      const elevenMsg = elevenErr instanceof Error ? elevenErr.message : "failed";
      const sarvamMsg = sarvamErr instanceof Error ? sarvamErr.message : "failed";
      throw new HttpError(503, `No text-to-speech provider available. elevenlabs: ${elevenMsg}; sarvam: ${sarvamMsg}`);
    }
  }
}
