export interface ProviderModel {
  modelId: string;
  displayName: string;
  capabilities: {
    chat?: boolean;
    vision?: boolean;
    tts?: boolean;
    stt?: boolean;
  };
}

export interface ChatImage {
  mime: string;
  /** A full `data:<mime>;base64,<...>` URL, exactly as the browser's FileReader produced it. */
  dataUrl: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** Image attachments on a user message — only ever set on the most recent turn (see
   *  chatService's attachImages()); adapters without vision support ignore this field. */
  images?: ChatImage[];
}

export interface HealthCheckResult {
  ok: boolean;
  error?: string;
}

/**
 * Every AI provider (OpenAI, Anthropic, Gemini, OpenRouter, Sarvam AI, ElevenLabs, Ollama)
 * implements this same shape so the admin/chat layers never special-case a vendor.
 */
export interface ProviderAdapter {
  slug: string;
  listModels(apiKey: string): Promise<ProviderModel[]>;
  chat(apiKey: string, model: string, messages: ChatMessage[]): Promise<string>;
  healthCheck(apiKey: string): Promise<HealthCheckResult>;
  /**
   * Optional token-by-token variant of `chat()`. Calls `onDelta` with each text chunk as it
   * arrives and resolves to the same full accumulated text `chat()` would have returned.
   * Adapters without a native streaming API can omit this — callers fall back to `chat()`.
   *
   * `onThink`, when provided, receives a reasoning model's hidden "thinking" trace (e.g.
   * Sarvam's `reasoning_content`) separately from `onDelta` so it never leaks into the visible
   * answer. Adapters whose provider has no such trace can ignore the parameter.
   */
  chatStream?(
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    signal?: AbortSignal,
    onThink?: (text: string) => void,
  ): Promise<string>;
}

export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Unknown error";
}

/** Strips the `data:image/png;base64,` prefix off a data URL, leaving just the base64 payload
 *  that Anthropic/Gemini/ScaleMax's image blocks want (unlike OpenAI's image_url, which takes
 *  the whole data URL as-is). */
export function base64PayloadOf(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/**
 * Anthropic's /messages API (and ScaleMax, which proxies it) wants plain string content for a
 * text-only turn, but a content-block array — images before text, per Anthropic's own examples —
 * for a turn carrying attachments. Shared by anthropic.ts and scalemax.ts since they're the same
 * wire format.
 */
export function toAnthropicStyleMessages(conversation: ChatMessage[]) {
  return conversation.map((m) => {
    if (!m.images?.length) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        ...m.images.map((img) => ({
          type: "image",
          source: { type: "base64", media_type: img.mime, data: base64PayloadOf(img.dataUrl) },
        })),
        { type: "text", text: m.content },
      ],
    };
  });
}

/**
 * Splits a message list into a single combined system prompt and the remaining conversation —
 * for providers (Anthropic, Gemini) whose API takes one top-level system string rather than
 * interleaved system-role messages. Joins every system message instead of keeping only the
 * first: chatService can prepend several (focus/honesty instructions, web search results,
 * behavior persona, the Think nudge), and dropping all but one silently disables the rest.
 */
export function splitSystemPrompt(messages: ChatMessage[]): { system: string | undefined; conversation: ChatMessage[] } {
  const systemMessages = messages.filter((m) => m.role === "system");
  const conversation = messages.filter((m) => m.role !== "system");
  const system = systemMessages.length > 0 ? systemMessages.map((m) => m.content).join("\n\n") : undefined;
  return { system, conversation };
}

/**
 * For OpenAI-style APIs (Sarvam, OpenAI, OpenRouter, Ollama) that take system-role messages
 * inline in the same array rather than a separate top-level field: chatService can prepend
 * several separate system messages (focus/honesty, web search, behavior, Think, Canvas), and at
 * least one production model (Sarvam's reasoning model) visibly got confused seeing several
 * system turns in a row before the real conversation — it reasoned about "no actual user
 * message" and quoted a system prompt back as if unsure whether it was the user's input. Merging
 * into one leading system message removes the ambiguity without changing the API shape.
 */
export function mergeSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemMessages = messages.filter((m) => m.role === "system");
  if (systemMessages.length <= 1) return messages;
  const conversation = messages.filter((m) => m.role !== "system");
  const merged: ChatMessage = { role: "system", content: systemMessages.map((m) => m.content).join("\n\n") };
  return [merged, ...conversation];
}

/** OpenAI-style `image_url` content blocks (OpenAI, OpenRouter) — unlike Anthropic/Gemini, these
 *  take the data URL as-is, no base64 stripping. */
export function toOpenAiStyleMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (!m.images?.length) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        { type: "text", text: m.content },
        ...m.images.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } })),
      ],
    };
  });
}
