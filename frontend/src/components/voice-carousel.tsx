import { useEffect, useRef, useState } from "react";
import { motion, type PanInfo } from "framer-motion";
import { Loader2 } from "lucide-react";
import { fetchVoices, hueForVoice, randomDemoLine, speak, type VoiceOption } from "@/lib/chat/voices";
import type { LiveAnalyser } from "@/lib/audio/analyser";
import { ParticleSphere } from "@/components/particle-sphere";
import { cn } from "@/lib/utils";

type GenderFilter = "all" | "male" | "female";

const CARD_WIDTH = 176;
const CARD_GAP = 20;
const STEP = CARD_WIDTH + CARD_GAP;
const AUTO_SPEAK_DELAY = 400;

/**
 * Horizontal, swipeable voice picker — the centered card is the selected voice, and it speaks a
 * quick friendly demo automatically whenever a new one settles in the center (including on first
 * load), so choosing a voice for Friday feels like meeting it rather than reading a name off a list.
 */
export function VoiceCarousel({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (voice: VoiceOption) => void;
}) {
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<GenderFilter>("all");
  const [index, setIndex] = useState(0);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [analyser, setAnalyser] = useState<LiveAnalyser | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const autoSpeakTimer = useRef<number | null>(null);

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
      stopRef.current?.();
      if (autoSpeakTimer.current) window.clearTimeout(autoSpeakTimer.current);
    };
  }, []);

  const filtered = (voices ?? []).filter((v) => filter === "all" || v.gender === filter);

  // Keep index in range when the filter changes the list length.
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, voices]);

  // Auto-speak whichever voice settles in the center — debounced so a fast swipe through several
  // cards doesn't fire a TTS call for each one it passes.
  useEffect(() => {
    const voice = filtered[index];
    stopRef.current?.();
    setAnalyser(null);
    setSpeakingId(null);
    if (autoSpeakTimer.current) window.clearTimeout(autoSpeakTimer.current);
    if (!voice) return;

    onSelect(voice);
    autoSpeakTimer.current = window.setTimeout(async () => {
      setLoadingId(voice.voiceId);
      try {
        const spoken = await speak(randomDemoLine(voice.language), voice.voiceId);
        stopRef.current = spoken.stop;
        setLoadingId(null);
        setSpeakingId(voice.voiceId);
        setAnalyser(spoken.analyser);
        void spoken.done.then(() => {
          setSpeakingId((p) => (p === voice.voiceId ? null : p));
          setAnalyser(null);
        });
      } catch {
        setLoadingId(null);
      }
    }, AUTO_SPEAK_DELAY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, filtered.length]);

  function handleDragEnd(_e: unknown, info: PanInfo) {
    const threshold = STEP / 3;
    const power = info.offset.x + info.velocity.x * 0.15;
    if (power < -threshold && index < filtered.length - 1) setIndex((i) => i + 1);
    else if (power > threshold && index > 0) setIndex((i) => i - 1);
  }

  const trackOffset = -index * STEP;

  return (
    <div className="flex w-full flex-col items-center gap-5">
      <div className="flex gap-1 self-center rounded-full bg-chip p-0.5 text-sm">
        {(["all", "female", "male"] as const).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => {
              setFilter(g);
              setIndex(0);
            }}
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
        <div className="flex items-center gap-2 py-10 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" />
          Loading voices…
        </div>
      )}

      {voices && filtered.length > 0 && (
        <>
          <div className="relative w-full overflow-hidden py-2" style={{ height: CARD_WIDTH + 8 }}>
            <motion.div
              className="absolute top-2 left-1/2 flex cursor-grab active:cursor-grabbing"
              style={{ gap: CARD_GAP, marginLeft: -CARD_WIDTH / 2 }}
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.15}
              onDragEnd={handleDragEnd}
              animate={{ x: trackOffset }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
            >
              {filtered.map((v, i) => {
                const centered = i === index;
                const speaking = speakingId === v.voiceId;
                const loading = loadingId === v.voiceId;
                return (
                  <motion.button
                    key={v.voiceId}
                    type="button"
                    onClick={() => setIndex(i)}
                    animate={{ scale: centered ? 1 : 0.78, opacity: centered ? 1 : 0.4 }}
                    transition={{ duration: 0.25 }}
                    style={{ width: CARD_WIDTH }}
                    className="flex shrink-0 flex-col items-center gap-2"
                  >
                    <div className="relative size-24 shrink-0">
                      <ParticleSphere
                        analyser={centered ? analyser : null}
                        active={centered && speaking}
                        hue={hueForVoice(v.voiceId)}
                        pointCount={centered ? 500 : 200}
                      />
                      {centered && loading && (
                        <Loader2 className="absolute inset-0 m-auto size-5 animate-spin text-muted" />
                      )}
                    </div>
                    <span className={cn("truncate text-sm font-medium", centered ? "text-foreground" : "text-muted")}>
                      {v.name}
                    </span>
                    <span className="truncate text-xs text-subtle capitalize">
                      {v.gender}
                      {v.accent ? ` · ${v.accent}` : ""}
                    </span>
                  </motion.button>
                );
              })}
            </motion.div>
          </div>

          <div className="flex items-center gap-1.5">
            {filtered.map((v, i) => (
              <div
                key={v.voiceId}
                className={cn(
                  "h-1.5 rounded-full transition-all duration-300",
                  i === index ? "w-4 bg-foreground" : "w-1.5 bg-border",
                )}
              />
            ))}
          </div>
          <p className="text-xs text-subtle">Swipe or drag to browse — Friday says hello as each one centers.</p>
        </>
      )}
    </div>
  );
}
