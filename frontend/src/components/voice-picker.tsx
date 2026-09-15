import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Pause, Play } from "lucide-react";
import { fetchVoices, hueForVoice, randomDemoLine, speak, type VoiceOption } from "@/lib/chat/voices";
import { ParticleSphere } from "@/components/particle-sphere";
import type { LiveAnalyser } from "@/lib/audio/analyser";
import { attachAnalyserToElement } from "@/lib/audio/analyser";
import { cn } from "@/lib/utils";

type GenderFilter = "all" | "male" | "female";

export function VoicePicker({
  selectedId,
  onSelect,
  compact,
  demo,
}: {
  selectedId: string | null;
  onSelect: (voice: VoiceOption) => void;
  /** Tighter spacing for embedding inside Settings rather than the full-screen voice-mode intro. */
  compact?: boolean;
  /** Preview with a live, randomly-picked friendly line instead of the static ElevenLabs sample clip. */
  demo?: boolean;
}) {
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<GenderFilter>("all");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [playingAnalyser, setPlayingAnalyser] = useState<LiveAnalyser | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopSpokenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchVoices()
      .then((v) => {
        if (!cancelled) setVoices(v);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load voices");
      });
    return () => {
      cancelled = true;
      audioRef.current?.pause();
      stopSpokenRef.current?.();
    };
  }, []);

  async function togglePreview(voice: VoiceOption) {
    if (playingId === voice.voiceId) {
      audioRef.current?.pause();
      stopSpokenRef.current?.();
      setPlayingId(null);
      setPlayingAnalyser(null);
      return;
    }
    audioRef.current?.pause();
    stopSpokenRef.current?.();
    setPlayingAnalyser(null);

    if (demo) {
      setLoadingId(voice.voiceId);
      try {
        const spoken = await speak(randomDemoLine(voice.language), voice.voiceId);
        stopSpokenRef.current = spoken.stop;
        setLoadingId(null);
        setPlayingId(voice.voiceId);
        setPlayingAnalyser(spoken.analyser);
        void spoken.done.then(() => {
          setPlayingId((p) => (p === voice.voiceId ? null : p));
          setPlayingAnalyser(null);
        });
      } catch (err) {
        setLoadingId(null);
        setError(err instanceof Error ? err.message : "Couldn't play that voice");
      }
      return;
    }

    if (!voice.previewUrl) return;
    const audio = new Audio(voice.previewUrl);
    audioRef.current = audio;
    const analyser = attachAnalyserToElement(audio);
    setPlayingAnalyser(analyser);
    audio.addEventListener(
      "ended",
      () => {
        setPlayingId(null);
        setPlayingAnalyser(null);
        analyser?.close();
      },
      { once: true },
    );
    void audio.play();
    setPlayingId(voice.voiceId);
  }

  const filtered = (voices ?? []).filter((v) => filter === "all" || v.gender === filter);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 self-start rounded-full bg-chip p-0.5 text-sm">
        {(["all", "female", "male"] as const).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setFilter(g)}
            className={cn(
              "rounded-full px-3 py-1 capitalize",
              filter === g ? "bg-composer text-foreground" : "text-muted",
            )}
          >
            {g}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {!voices && !error && (
        <div className="flex items-center gap-2 py-6 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" />
          Loading voices…
        </div>
      )}

      {voices && (
        <div className={cn("grid gap-2", compact ? "max-h-72 overflow-y-auto scroll-thin pr-1" : "sm:grid-cols-2")}>
          {filtered.map((v) => {
            const selected = v.voiceId === selectedId;
            const playing = playingId === v.voiceId;
            const loading = loadingId === v.voiceId;
            return (
              <div
                key={v.voiceId}
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-3 py-2.5 transition-colors",
                  selected ? "border-primary bg-primary/5" : "border-border hover:bg-chip",
                )}
              >
                <button
                  type="button"
                  onClick={() => void togglePreview(v)}
                  disabled={(!demo && !v.previewUrl) || loading}
                  aria-label={playing ? `Stop preview of ${v.name}` : `Preview ${v.name}`}
                  className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-chip transition-colors hover:bg-elevated disabled:opacity-40"
                >
                  <ParticleSphere
                    analyser={playing ? playingAnalyser : null}
                    active={playing}
                    hue={hueForVoice(v.voiceId)}
                    pointCount={140}
                  />
                  <span
                    className="absolute inset-0 flex items-center justify-center text-white"
                    style={{ filter: "drop-shadow(0 0 2px rgba(0,0,0,0.55))" }}
                  >
                    {loading ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : playing ? (
                      <Pause className="size-3" />
                    ) : (
                      <Play className="size-3" />
                    )}
                  </span>
                </button>
                <button type="button" onClick={() => onSelect(v)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-medium text-foreground">{v.name}</span>
                  <span className="block truncate text-xs text-muted capitalize">
                    {v.gender}
                    {v.accent ? ` · ${v.accent}` : ""}
                  </span>
                </button>
                {selected && <Check className="size-4 shrink-0 text-primary" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
