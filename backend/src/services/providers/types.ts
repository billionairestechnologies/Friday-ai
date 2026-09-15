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

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
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
