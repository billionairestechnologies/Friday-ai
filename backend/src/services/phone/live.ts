/**
 * Gemini Live is the ear and the mouth. Friday still decides the words.
 * Context-window compression is on so a long call does not re-bill audio still in the session.
 */

export const LIVE_INSTRUCTION = [
  "You are Friday's voice, not a second assistant.",
  "Transcribe the caller. When you are given a line to say, speak that line and nothing else.",
  "Do not add questions, greetings, or filler.",
].join(" ");

export function liveModel() {
  return process.env.FRIDAY_LIVE_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025";
}

export function liveSetup(model = liveModel(), instruction = LIVE_INSTRUCTION) {
  const name = model.startsWith("models/") ? model : `models/${model}`;
  return {
    setup: {
      model: name,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
      },
      systemInstruction: { parts: [{ text: instruction }] },
      contextWindowCompression: { slidingWindow: { targetTokens: 8_000 } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

type LiveMessage = {
  setupComplete?: unknown;
  serverContent?: {
    turnComplete?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    modelTurn?: { parts?: { inlineData?: { data?: string } }[] };
  };
};

type SocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void;
};

const sessions = new Map<string, LiveSession>();

async function geminiKey(): Promise<string> {
  const fromEnv = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (fromEnv) return fromEnv;
  const { getWorkingKeyForProvider } = await import("../providerService.js");
  return getWorkingKeyForProvider("gemini");
}

export class LiveSession {
  private socket: SocketLike | null = null;
  private queue: LiveMessage[] = [];
  private waiters: ((msg: LiveMessage) => void)[] = [];
  heard = "";

  constructor(private readonly id: string) {}

  async connect() {
    if (this.socket) return;
    const key = await geminiKey();
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;
    const socket = new WebSocket(url) as unknown as SocketLike;
    socket.addEventListener("message", (ev) => {
      let msg: LiveMessage;
      try {
        msg = JSON.parse(String(ev.data ?? "")) as LiveMessage;
      } catch {
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Gemini Live did not connect.")), 8_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Gemini Live did not connect."));
      });
    });
    this.socket = socket;
    socket.send(JSON.stringify(liveSetup()));
    await this.until((msg) => Boolean(msg.setupComplete), 8_000);
  }

  /** Send one PCM chunk and return the caller's words once the turn closes. */
  async hear(audioBase64: string): Promise<string> {
    await this.connect();
    this.socket?.send(JSON.stringify({
      realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: audioBase64 } },
    }));
    this.socket?.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    let text = "";
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const msg = await this.next(Math.max(200, deadline - Date.now()));
      const heard = msg.serverContent?.inputTranscription?.text;
      if (heard) text = `${text} ${heard}`.trim();
      if (msg.serverContent?.turnComplete) break;
    }
    this.heard = text;
    return text;
  }

  /** Speak Friday's line. Returns PCM base64, or empty when the socket has no audio yet. */
  async speak(line: string): Promise<string> {
    if (!line.trim() || !this.socket) return "";
    this.socket.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: `Say exactly this and nothing else: ${line}` }] }],
        turnComplete: true,
      },
    }));
    const chunks: Buffer[] = [];
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const msg = await this.next(Math.max(200, deadline - Date.now()));
      for (const part of msg.serverContent?.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) chunks.push(Buffer.from(part.inlineData.data, "base64"));
      }
      if (msg.serverContent?.turnComplete) break;
    }
    return Buffer.concat(chunks).toString("base64");
  }

  close() {
    this.socket?.close();
    this.socket = null;
    sessions.delete(this.id);
  }

  private next(ms: number): Promise<LiveMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Gemini Live went quiet.")), ms);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  private async until(match: (msg: LiveMessage) => boolean, ms: number) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const msg = await this.next(deadline - Date.now());
      if (match(msg)) return msg;
    }
    throw new Error("Gemini Live setup did not finish.");
  }
}

export async function liveSession(id: string) {
  const existing = sessions.get(id);
  if (existing) return existing;
  const created = new LiveSession(id);
  sessions.set(id, created);
  return created;
}

export function resetLiveSessions() {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}
