import { api, API_BASE_URL, getAccessToken } from "@/lib/api";
import { attachAnalyserToElement, type LiveAnalyser } from "@/lib/audio/analyser";
import { useAuthStore } from "@/lib/auth/client";

export type VoiceOption = {
  voiceId: string;
  name: string;
  gender: "male" | "female" | "neutral";
  /** BCP-47-ish language tag ("en", "hi", "gu") — picks which demo-line pool gets read. */
  language: string;
  accent?: string;
  description?: string;
  previewUrl: string | null;
};

export async function fetchVoices(): Promise<VoiceOption[]> {
  const res = await api.get<{ voices: VoiceOption[] }>("/voice/voices");
  return res.voices;
}

/** A short, varied set of friendly openers for demoing a voice — picked at random, never robotic. */
const VOICE_DEMO_LINES: Record<string, string[]> = {
  en: [
    "Hey there! Nice to meet you.",
    "Hi, how are you doing today?",
    "Hello! I'm ready whenever you are.",
    "Hey! What's on your mind?",
    "Hi there, good to hear from you.",
  ],
  hi: [
    "नमस्ते! मैं फ्राइडे हूँ, आपसे मिलकर अच्छा लगा।",
    "नमस्ते, आप कैसे हैं?",
    "हैलो! जब आप तैयार हों, मुझे बताइए।",
  ],
  gu: [
    "નમસ્તે! હું ફ્રાઈડે છું, તમને મળીને આનંદ થયો.",
    "નમસ્તે, તમે કેમ છો?",
    "હેલો! તમે તૈયાર હો ત્યારે કહેજો.",
  ],
};

export function randomDemoLine(language: string = "en"): string {
  const pool = VOICE_DEMO_LINES[language] ?? VOICE_DEMO_LINES.en!;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

export type SpokenAudio = {
  audio: HTMLAudioElement;
  analyser: LiveAnalyser | null;
  stop: () => void;
  done: Promise<void>;
};

async function fetchSpeech(text: string, voiceId: string | null | undefined, isRetry = false): Promise<Response> {
  const token = getAccessToken();
  const res = await fetch(`${API_BASE_URL}/voice/speak`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text, voiceId: voiceId || undefined }),
  });
  // The access token is short-lived — a tab open longer than that needs one refresh+retry
  // rather than surfacing a raw 401 for what the user just heard as "nothing happened."
  if (res.status === 401 && !isRetry) {
    const refreshed = await useAuthStore.getState().refresh();
    if (refreshed) return fetchSpeech(text, voiceId, true);
  }
  return res;
}

/**
 * Synthesizes and plays one line through the backend TTS endpoint, wired to a live analyser for
 * visuals. Pass `reuseAudio` — an `<audio>` element that already had `.play()` called on it
 * synchronously within a real user gesture (see voice-mode.tsx's unlockAudioForLaterPlayback) —
 * to inherit that element's autoplay activation instead of getting blocked on a brand-new one.
 */
export async function speak(text: string, voiceId?: string | null, reuseAudio?: HTMLAudioElement): Promise<SpokenAudio> {
  const res = await fetchSpeech(text, voiceId);
  if (!res.ok) throw new Error(`Speech synthesis failed: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  const audio = reuseAudio ?? new Audio();
  audio.src = url;
  const analyser: LiveAnalyser | null = attachAnalyserToElement(audio);

  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const cleanup = () => {
    analyser?.close();
    URL.revokeObjectURL(url);
    resolveDone();
  };
  audio.addEventListener("ended", cleanup, { once: true });
  audio.addEventListener("error", cleanup, { once: true });

  // `void audio.play().catch(cleanup)` used to treat a BLOCKED play() (the browser's autoplay
  // policy rejecting it — very plausible here: the actual play() call happens well after the
  // "Stop and send" click, once TTS synthesis finishes over the network, by which point Chrome's
  // user-activation window can have expired) exactly the same as a successful, completed
  // playback — cleanup() only ever RESOLVES `done`, never rejects it. speak() returned
  // successfully either way, so the caller had no way to know audio never actually started, and
  // reported "not speaking back" with zero error surfaced anywhere. Awaiting play() here and
  // throwing on failure makes that a real, catchable error instead of a silent no-op.
  try {
    await audio.play();
  } catch (err) {
    cleanup();
    throw err instanceof Error ? err : new Error("Playback was blocked by the browser");
  }

  return {
    audio,
    analyser,
    stop: () => {
      audio.pause();
      cleanup();
    },
    done,
  };
}

/** Deterministic hue per voice, so each picked voice gets a visually distinct sphere. */
export function hueForVoice(voiceId: string | null): number {
  if (!voiceId) return 205;
  let hash = 0;
  for (let i = 0; i < voiceId.length; i++) hash = (hash * 31 + voiceId.charCodeAt(i)) >>> 0;
  return hash % 360;
}
