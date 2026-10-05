import { useEffect, useState } from "react";
import { BotAvatar } from "bot-avatars";
import { ThinkingOrb } from "thinking-orbs";
import { VoiceBeam, useMicrophone } from "voice-glow";
import { api } from "@/lib/api";

export function FridayFace({ busy, listening, size = 72 }: { busy?: boolean; listening?: boolean; size?: number }) {
  return (
    <BotAvatar
      type="clover"
      face="mouth"
      headphones
      shading="plastic"
      size={size}
      state={busy || listening ? "working" : "default"}
      aria-label={listening ? "Friday, listening" : busy ? "Friday, working" : "Friday"}
    />
  );
}

const ORB = {
  thinking: "solving",
  searching: "searching",
  writing: "composing",
  building: "weaving",
  working: "working",
} as const;

export function FridayThinking({ status }: { status?: string | null }) {
  const state = status && status in ORB ? ORB[status as keyof typeof ORB] : "working";
  return (
    <span className="inline-flex items-center gap-2">
      <ThinkingOrb state={state} size={20} aria-label="Friday is thinking" />
    </span>
  );
}

export function AirCallPanel({ conversationId, onClose }: { conversationId?: string; onClose: () => void }) {
  const mic = useMicrophone();
  const [callId, setCallId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    api
      .post<{ id: string }>("/air/calls", conversationId ? { conversationId } : {})
      .then((res) => {
        if (!gone) setCallId(res.id);
      })
      .catch((err: unknown) => {
        if (!gone) setError(err instanceof Error ? err.message : "Couldn't open the call.");
      });
    return () => {
      gone = true;
    };
  }, [conversationId]);

  async function hangUp() {
    mic.stop();
    if (callId) await api.post(`/air/calls/${callId}/end`, {}).catch(() => {});
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm">
      <VoiceBeam type="mobile" stream={mic.stream} level={mic.state === "live" ? undefined : 0.15} theme="auto">
        <div className="flex w-[min(100%,24rem)] flex-col items-center gap-4 rounded-3xl border border-border bg-composer px-6 py-8 text-center">
          <FridayFace listening={mic.state === "live"} busy={Boolean(callId)} size={96} />
          <div>
            <h2 className="text-xl font-medium text-foreground">On the line</h2>
            <p className="mt-1 text-sm text-muted">
              {error ?? "This is Friday, in the browser. The phone number connects when the trunk is configured."}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="h-10 rounded-full bg-foreground px-4 text-sm font-medium text-background"
              onClick={() => (mic.state === "live" ? mic.stop() : void mic.start())}
            >
              {mic.state === "live" ? "Mute" : "Talk"}
            </button>
            <button type="button" className="h-10 rounded-full border border-border px-4 text-sm" onClick={() => void hangUp()}>
              Hang up
            </button>
          </div>
        </div>
      </VoiceBeam>
    </div>
  );
}

export function AirPassphraseCard() {
  const [phrase, setPhrase] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await api.put("/air/passphrase", { phrase });
      setSaved(true);
      setPhrase("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that.");
    }
  }

  return (
    <form
      className="mt-6 w-full max-w-md text-left"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="text-xs font-medium text-muted" htmlFor="air-phrase">
        Passphrase before pay, send, or delete
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id="air-phrase"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          className="h-10 min-w-0 flex-1 rounded-full border border-border bg-composer px-3 text-sm"
          autoComplete="off"
        />
        <button type="submit" className="h-10 rounded-full border border-border px-3 text-sm">
          Save
        </button>
      </div>
      {saved && <p className="mt-1 text-xs text-muted">Saved. Friday will ask for it on those actions.</p>}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </form>
  );
}
