import { anthropicAdapter } from "./anthropic.js";
import { elevenlabsAdapter } from "./elevenlabs.js";
import { geminiAdapter } from "./gemini.js";
import { ollamaAdapter } from "./ollama.js";
import { openaiAdapter } from "./openai.js";
import { openrouterAdapter } from "./openrouter.js";
import { sarvamAdapter } from "./sarvam.js";
import type { ProviderAdapter } from "./types.js";

export const PROVIDER_REGISTRY: Record<string, ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  openrouter: openrouterAdapter,
  sarvam: sarvamAdapter,
  elevenlabs: elevenlabsAdapter,
  ollama: ollamaAdapter,
};

export function getProviderAdapter(slug: string): ProviderAdapter {
  const adapter = PROVIDER_REGISTRY[slug];
  if (!adapter) throw new Error(`Unknown provider: ${slug}`);
  return adapter;
}
