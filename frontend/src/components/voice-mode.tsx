import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Mic, MicOff, X } from "lucide-react";
import { createLiveAnalyser, type LiveAnalyser } from "@/lib/audio/analyser";
import { hueForVoice, speak, type VoiceOption } from "@/lib/chat/voices";
import { useLiveStream } from "@/lib/chat/live-stream";
import { useChat } from "@/lib/chat/store";
import { VoiceCarousel } from "@/components/voice-carousel";
import { ParticleSphere } from "@/components/particle-sphere";
import { api } from "@/lib/api";

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type Phase = "intro" | "listening" | "responding";

export function VoiceMode({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (text: string) => void;
}) {
  const voiceId = useChat((s) => s.voiceId);
  const voiceIntroSeen = useChat((s) => s.voiceIntroSeen);
  const setVoice = useChat((s) => s.setVoice);
  const setVoiceIntroSeen = useChat((s) => s.setVoiceIntroSeen);
  const live = useLiveStream();

  const [phase, setPhase] = useState<Phase>("listening");
  const [analyser, setAnalyser] = useState<LiveAnalyser | null>(null);
  const [hearing, setHearing] = useState(false);
  const [caption, setCaption] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const finalTranscriptRef = useRef("");
  const awaitingReplyRef = useRef(false);
  const watchingAssistantIdRef = useRef<string | null>(null);
  const spokenStopRef = useRef<(() => void) | null>(null);

  const hue = hueForVoice(voiceId);

  // Reset per-open state, and decide whether to show the first-time voice picker.
  useEffect(() => {
    if (!open) return;
    setPhase(voiceIntroSeen ? "listening" : "intro");
    setReplyText("");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || phase !== "listening") return;
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const liveA = createLiveAnalyser(stream);
        setAnalyser(liveA);

        const hearingLoop = () => {
          if (cancelled) return;
          setHearing(liveA.getLevel() > 0.08);
          window.setTimeout(hearingLoop, 120);
        };
        hearingLoop();

        // Fallback path: always record audio too, so we can transcribe via the backend if
        // the browser has no built-in speech recognition (Safari, Firefox).
        const recorder = new MediaRecorder(stream);
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        mediaRecorderRef.current = recorder;
        recorder.start();

        const Ctor = getSpeechRecognitionCtor();
        if (Ctor) {
          const recognition = new Ctor();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = navigator.language || "en-US";
          recognition.onresult = (ev) => {
            const e = ev as { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> };
            let interim = "";
            for (let i = e.resultIndex; i < e.results.length; i++) {
              const res = e.results[i]!;
              if (res.isFinal) finalTranscriptRef.current += res[0].transcript;
              else interim += res[0].transcript;
            }
            setCaption((finalTranscriptRef.current + " " + interim).trim());
          };
          recognition.onerror = () => {
            /* keep listening — a transient no-speech/network blip shouldn't end the session */
          };
          recognition.start();
          recognitionRef.current = recognition;
        }
      } catch {
        setError("Couldn't access the microphone");
      }
    }
    void start();

    return () => {
      cancelled = true;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      if (mediaRecorderRef.current?.state !== "inactive") mediaRecorderRef.current?.stop();
      mediaRecorderRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setAnalyser((prev) => {
        prev?.close();
        return null;
      });
      setCaption("");
      setHearing(false);
      finalTranscriptRef.current = "";
    };
  }, [open, phase]);

  // Once the turn we submitted finishes streaming, speak the reply and animate the sphere to it.
  useEffect(() => {
    if (awaitingReplyRef.current && live) {
      awaitingReplyRef.current = false;
      watchingAssistantIdRef.current = live.assistantId;
    } else if (watchingAssistantIdRef.current && !live) {
      const assistantId = watchingAssistantIdRef.current;
      watchingAssistantIdRef.current = null;
      const chat = useChat.getState().chats.find((c) => c.id === useChat.getState().activeId);
      const msg = chat?.messages.find((m) => m.id === assistantId);
      const text = msg?.content?.trim();
      if (text) {
        setReplyText(text);
        void speakReply(text);
      } else {
        // Previously silently closed here — from the user's side that's indistinguishable from
        // "the AI just didn't respond," which is exactly what got reported. Every error path in
        // this component used to close with zero explanation; this is the first of a few fixes
        // making a real failure visible instead of a bare, unexplained overlay disappearing.
        setError(msg?.error || "Didn't get a reply — try again.");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // Voice Mode has no way to know WHY a turn never starts streaming (send() bailing out early —
  // a stuck busy flag, no active conversation, an auth hiccup — never calls startLive, so `live`
  // never goes truthy and the effect above never fires). Without this, that leaves the user
  // staring at "Thinking…" forever with no feedback at all — reported live as "not responding
  // back." This is a plain safety net, not the primary path.
  useEffect(() => {
    if (phase !== "responding") return;
    const timeout = window.setTimeout(() => {
      if (phase === "responding" && !replyText) {
        setError("This is taking too long — try again.");
      }
    }, 25_000);
    return () => window.clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function speakReply(text: string) {
    try {
      const spoken = await speak(text, voiceId);
      spokenStopRef.current = spoken.stop;
      setAnalyser(spoken.analyser);
      setHearing(true);
      await spoken.done;
      onClose();
    } catch {
      // TTS failed — the reply text is already visible in the main chat transcript (it was
      // inserted before this ever runs), but silently closing the voice overlay here still
      // reads as "nothing happened" in the moment. Show it instead of vanishing.
      setError("Couldn't play that reply out loud — it's in the chat as text.");
    }
  }

  function stopEverything() {
    spokenStopRef.current?.();
    recognitionRef.current?.abort();
    if (mediaRecorderRef.current?.state !== "inactive") mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }

  function handleClose() {
    stopEverything();
    onClose();
  }

  function pickVoice(v: VoiceOption) {
    setVoice(v.voiceId, v.name);
  }

  function continueFromIntro() {
    setVoiceIntroSeen(true);
    setPhase("listening");
  }

  async function finishAndSubmit() {
    recognitionRef.current?.stop();
    const text = (finalTranscriptRef.current || caption).trim();
    const recorder = mediaRecorderRef.current;

    async function submit(finalText: string) {
      awaitingReplyRef.current = true;
      setPhase("responding");
      onSubmit(finalText);
    }

    if (text) {
      await submit(text);
      return;
    }

    // No speech-recognition transcript (unsupported browser) — fall back to the recorded
    // audio blob and the existing batch transcription endpoint.
    if (recorder && recorder.state !== "inactive") {
      const transcribed = await new Promise<string>((resolve) => {
        recorder.onstop = async () => {
          try {
            const blob = new Blob(chunksRef.current, { type: "audio/webm" });
            const form = new FormData();
            form.append("audio", blob, "recording.webm");
            const res = await api.post<{ text: string }>("/voice/transcribe", form);
            resolve(res.text);
          } catch {
            resolve("");
          }
        };
        recorder.stop();
      });
      if (transcribed.trim()) {
        await submit(transcribed.trim());
        return;
      }
    }
    setError("Didn't catch anything — try again");
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[60] flex flex-col items-center justify-between bg-background px-6 py-10"
        >
          <div className="flex w-full justify-end">
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close voice mode"
              className="flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-chip hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>

          {phase === "intro" ? (
            <div className="flex min-h-0 w-full max-w-xl flex-1 flex-col items-center justify-center gap-5">
              <h2 className="text-xl font-semibold text-foreground">Pick a voice for Friday</h2>
              <p className="text-center text-sm text-muted">
                Tap play to hear a quick hello — you can change this anytime in Settings.
              </p>
              <VoiceCarousel selectedId={voiceId} onSelect={pickVoice} />
              <button
                type="button"
                onClick={continueFromIntro}
                disabled={!voiceId}
                className="mt-2 rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Continue
              </button>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8">
              <p className="max-w-lg text-balance px-6 text-center text-2xl font-medium text-foreground">
                {phase === "responding"
                  ? replyText || "Thinking…"
                  : caption || "Say something…"}
              </p>
              <div className="size-64 max-w-[70vw]">
                <ParticleSphere analyser={analyser} active={hearing} hue={hue} />
              </div>
              {phase === "responding" && !replyText && !error && (
                <Loader2 className="size-5 animate-spin text-muted" />
              )}
              {error && (
                <div className="flex flex-col items-center gap-3">
                  <p className="text-sm text-danger">{error}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setCaption("");
                      setReplyText("");
                      setPhase("listening");
                    }}
                    className="rounded-full border border-border px-4 py-1.5 text-sm text-foreground transition-colors hover:bg-chip"
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>
          )}

          {phase === "listening" && (
            <div className="flex items-center gap-6 pb-4">
              <button
                type="button"
                onClick={handleClose}
                aria-label="Cancel"
                className="flex size-14 items-center justify-center rounded-full border border-border text-muted transition-colors hover:bg-chip hover:text-foreground"
              >
                <X className="size-5" />
              </button>
              <button
                type="button"
                onClick={() => void finishAndSubmit()}
                aria-label="Stop and send"
                className="flex size-16 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[var(--shadow-composer)] transition-opacity hover:opacity-90"
              >
                {hearing ? <Mic className="size-6" /> : <MicOff className="size-6" />}
              </button>
            </div>
          )}

          {phase === "responding" && (
            <div className="pb-4">
              <button
                type="button"
                onClick={handleClose}
                aria-label="Stop"
                className="flex size-14 items-center justify-center rounded-full border border-border text-muted transition-colors hover:bg-chip hover:text-foreground"
              >
                <X className="size-5" />
              </button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
