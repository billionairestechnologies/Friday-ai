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
  const [left, setLeft] = useState<number | null>(null);
  const [dial, setDial] = useState<"browser" | "phone">("browser");

  useEffect(() => {
    let gone = false;
    api
      .post<{ id: string; dial?: { mode?: "browser" | "phone" }; allowance?: { left: number } }>("/air/calls", conversationId ? { conversationId } : {})
      .then((res) => {
        if (gone) return;
        setCallId(res.id);
        setDial(res.dial?.mode === "phone" ? "phone" : "browser");
        setLeft(res.allowance?.left ?? null);
      })
      .catch((err: unknown) => {
        if (!gone) setError(err instanceof Error ? err.message : "Couldn't open the call.");
      });
    return () => {
      gone = true;
    };
  }, [conversationId]);

  useEffect(() => {
    if (!callId) return;
    const timer = window.setInterval(() => {
      void api
        .post<{ left: number }>(`/air/calls/${callId}/tick`, { seconds: 15 })
        .then((res) => setLeft(res.left))
        .catch(() => {
          setError("This month's call minutes are used up.");
          window.clearInterval(timer);
        });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [callId]);

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
              {error ?? (dial === "phone" ? "Calling the number on your account." : "Friday is on the line in the browser. Call minutes still count.")}
            </p>
            {left != null && <p className="mt-1 text-xs text-muted">{left} call minutes left this month</p>}
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

export function AirScreen({ url, conversationId }: { url: string; conversationId?: string }) {
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [dropped, setDropped] = useState<string | null>(null);

  return (
    <div
      className="relative mt-4 h-72 w-full max-w-lg overflow-hidden rounded-2xl border border-border"
      onMouseMove={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        setCursor({ x: e.clientX - box.left, y: e.clientY - box.top });
      }}
      onMouseLeave={() => setCursor(null)}
      onTouchMove={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        const touch = e.touches[0];
        if (!touch) return;
        setCursor({ x: touch.clientX - box.left, y: touch.clientY - box.top });
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (!file || !conversationId) return;
        void file.text().then((content) => api.post(`/air/screen/${conversationId}/drop`, { name: file.name, content }).then(() => setDropped(file.name)));
      }}
    >
      <iframe title="Friday screen" src={url} className="h-full w-full" />
      {cursor && (
        <span
          className="pointer-events-none absolute size-4 rounded-full border-2 border-foreground bg-background/70"
          style={{ left: cursor.x - 8, top: cursor.y - 8 }}
        />
      )}
      <p className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-background/80 px-2 py-1 text-[11px] text-muted">
        {dropped ? `Added ${dropped}` : "Mouse or finger. Drop a file onto the screen."}
      </p>
    </div>
  );
}

export function AirLinkCard() {
  const [telegram, setTelegram] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [note, setNote] = useState<string | null>(null);

  async function link(channel: "telegram" | "whatsapp", externalId: string) {
    setNote(null);
    try {
      await api.post("/air/channels", { channel, externalId });
      setNote(`${channel} linked`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Couldn't link that.");
    }
  }

  return (
    <div className="mt-4 grid w-full max-w-md gap-2 text-left">
      <p className="text-xs font-medium text-muted">WhatsApp and Telegram</p>
      <div className="flex gap-2">
        <input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="Telegram chat id" className="h-9 min-w-0 flex-1 rounded-full border border-border bg-composer px-3 text-sm" />
        <button type="button" className="h-9 rounded-full border border-border px-3 text-sm" onClick={() => void link("telegram", telegram)}>Link</button>
      </div>
      <div className="flex gap-2">
        <input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="WhatsApp number" className="h-9 min-w-0 flex-1 rounded-full border border-border bg-composer px-3 text-sm" />
        <button type="button" className="h-9 rounded-full border border-border px-3 text-sm" onClick={() => void link("whatsapp", whatsapp)}>Link</button>
      </div>
      {note && <p className="text-xs text-muted">{note}</p>}
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
