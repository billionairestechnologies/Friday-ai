import { HttpError } from "../middleware/errorHandler.js";
import { getWorkingKeyForProvider } from "./providerService.js";
import { elevenlabsTranscribe } from "./providers/elevenlabs.js";
import { openaiTranscribe } from "./providers/openai.js";
import { sarvamTranscribe } from "./providers/sarvam.js";

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
