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
}

export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
