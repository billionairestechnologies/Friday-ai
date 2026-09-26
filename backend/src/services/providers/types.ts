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
  name?: string;
  size?: number;
  kind?: "image" | "file";
  /** A full `data:<mime>;base64,<...>` URL, exactly as the browser's FileReader produced it.
   *  Despite the name (kept for a smaller diff against existing call sites), this carries any
   *  attachment — images, PDFs, and (for Gemini, whose inline_data is mime-agnostic) short
   *  video/audio clips, not just images. Adapters branch on `mime` to build the right content
   *  block and skip file types their provider doesn't understand. */
  dataUrl: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** File attachments on a user message — only ever set on the most recent turn (see
   *  chatService's attachImages()); adapters without any attachment support ignore this field,
   *  and adapters that only support some mime types (e.g. Anthropic: images + PDF, not video)
   *  filter accordingly rather than sending a request their provider will reject. */
  images?: ChatImage[];
  /**
   * System messages only: true when this message's content is NOT byte-identical across repeated
   * requests of the same conversation/turn — search results, the current Canvas artifact snapshot,
   * a "you just attached a file" nudge. Prompt caching (promptCache.ts) puts these AFTER the stable,
   * repeated system text so the cacheable prefix stays byte-identical turn to turn. Unset/false is
   * the default and correct choice for ordinary static instruction text.
   */
  volatile?: boolean;
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
    onUsage?: (usage: import("../tokenUsage.js").TokenUsage) => void,
  ): Promise<string>;
  /**
   * Optional native tool calling (see toolCalling.ts): one streamed model turn that may end in tool
   * calls instead of (or after) text. Only adapters whose API supports structured tools implement
   * it; chat falls back to plain `chatStream` for the rest.
   */
  chatStreamWithTools?(
    apiKey: string,
    model: string,
    messages: import("./toolCalling.js").AgentMessage[],
    opts: import("./toolCalling.js").ToolTurnOptions,
    onDelta: (text: string) => void,
  ): Promise<import("./toolCalling.js").ToolTurnResult>;
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
 * text-only turn, but a content-block array — attachments before text, per Anthropic's own
 * examples — for a turn carrying attachments. Shared by anthropic.ts and scalemax.ts since
 * they're the same wire format.
 *
 * Anthropic natively understands images and PDFs (as a "document" block, not "image") but
 * nothing else — a video/audio attachment is silently dropped here rather than sent as a
 * malformed block the API would reject outright.
 */
export function toAnthropicStyleMessages(conversation: ChatMessage[]) {
  return conversation.map((m) => {
    const attachments = (m.images ?? []).filter((img) => img.mime.startsWith("image/") || img.mime === "application/pdf");
    if (attachments.length === 0) return { role: m.role, content: m.content };

    const blocks: Record<string, unknown>[] = attachments.map((img) =>
      img.mime === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: img.mime, data: base64PayloadOf(img.dataUrl) } }
        : { type: "image", source: { type: "base64", media_type: img.mime, data: base64PayloadOf(img.dataUrl) } },
    );
    // An empty text block ({type:"text", text:""}) is invalid — Anthropic rejects it the same
    // way it rejected an empty `messages` array (confirmed in production, 2026-09-16). Only add
    // the text block when there's actually text, e.g. an image sent with no caption.
    if (m.content.trim()) blocks.push({ type: "text", text: m.content });
    return { role: m.role, content: blocks };
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
 *  take the data URL as-is, no base64 stripping. `image_url` only ever means an image on these
 *  APIs (no PDF/document block in the standard chat-completions shape), so anything else in
 *  `images` is dropped here rather than sent as a broken image reference. */
export function toOpenAiStyleMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    const images = (m.images ?? []).filter((img) => img.mime.startsWith("image/"));
    if (images.length === 0) return { role: m.role, content: m.content };

    const parts: Record<string, unknown>[] = images.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl } }));
    // Same as Anthropic: an empty text part is invalid on some OpenAI-compatible backends
    // (confirmed for Anthropic-family APIs in production; skip it defensively here too).
    if (m.content.trim()) parts.unshift({ type: "text", text: m.content });
    return { role: m.role, content: parts };
  });
}

/** Ollama's /api/chat wants a sibling `images: string[]` field per message holding PLAIN base64
 *  payloads (no `data:mime;base64,` prefix, no image_url/content-block wrapper) — a different
 *  shape from every other adapter here. Previously `images` was silently forwarded unconverted
 *  (an array of {mime, dataUrl,...} objects), which a real Ollama server ignores/rejects, so a
 *  vision-capable local model (e.g. llava) never actually received the picture. */
export function toOllamaStyleMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    const images = (m.images ?? []).filter((img) => img.mime.startsWith("image/"));
    if (images.length === 0) return { role: m.role, content: m.content };
    return { role: m.role, content: m.content, images: images.map((img) => base64PayloadOf(img.dataUrl)) };
  });
}
