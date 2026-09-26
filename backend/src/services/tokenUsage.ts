export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated?: boolean;
  /** Portion of promptTokens served from the provider's own prompt cache (Anthropic: an explicit
   *  cache_control breakpoint hit; OpenAI: automatic — see providers/promptCache.ts). Billed at a
   *  fraction of the normal input rate; always <= promptTokens. Undefined/0 means no cache hit
   *  was reported (either caching is off, this was the first call, or the provider is Ollama/Sarvam,
   *  which don't report it) — cost falls back to the plain uncached rate exactly as before this field existed. */
  cachedTokens?: number;
  /** Portion of promptTokens spent WRITING a new cache entry (Anthropic only, billed once at a
   *  premium over the base input rate — see promptCache.ts). 0/undefined outside a cache write. */
  cacheWriteTokens?: number;
};

export function emptyTokenUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function mergeTokenUsage(a: TokenUsage | null | undefined, b: TokenUsage | null | undefined): TokenUsage {
  const left = a ?? emptyTokenUsage();
  const right = b ?? emptyTokenUsage();
  const cachedTokens = (left.cachedTokens ?? 0) + (right.cachedTokens ?? 0);
  const cacheWriteTokens = (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0);
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimated: Boolean(left.estimated || right.estimated),
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  };
}

/** Rough fallback when a provider stream does not report usage. */
export function estimateTokenUsageFromText(promptChars: number, completionChars: number): TokenUsage {
  const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
  const completionTokens = Math.max(0, Math.ceil(completionChars / 4));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

/**
 * Approximate USD cents for budgeting. Rates are intentionally conservative launch defaults —
 * not a billing invoice. Tune via env later if needed.
 */
// Anthropic publishes a fixed cache economics on top of its base input rate regardless of model:
// a cache READ is billed at 0.1x the base input rate, a cache WRITE (creating the entry) at 1.25x
// (the default 5-minute TTL — we never request the pricier 1-hour TTL). OpenAI's automatic caching
// (no cache_control needed — see promptCache.ts) bills cached reads at 0.5x input; it has no
// separate "write" charge. Providers that don't report cache fields are unaffected — cachedTokens/
// cacheWriteTokens default to 0 and the math below reduces to exactly the pre-caching formula.
const CACHE_READ_MULTIPLIER: Record<string, number> = { anthropic: 0.1, scalemax: 0.1, openai: 0.5, openrouter: 0.5 };
const CACHE_WRITE_MULTIPLIER: Record<string, number> = { anthropic: 1.25, scalemax: 1.25 };

export function estimateCostCents(providerSlug: string, usage: TokenUsage): number {
  const rates: Record<string, { inPer1k: number; outPer1k: number }> = {
    openai: { inPer1k: 0.5, outPer1k: 1.5 },
    anthropic: { inPer1k: 0.8, outPer1k: 2.4 },
    gemini: { inPer1k: 0.2, outPer1k: 0.6 },
    openrouter: { inPer1k: 0.6, outPer1k: 1.8 },
    sarvam: { inPer1k: 0.3, outPer1k: 0.9 },
    scalemax: { inPer1k: 0.5, outPer1k: 1.5 },
    ollama: { inPer1k: 0, outPer1k: 0 },
  };
  const rate = rates[providerSlug] ?? { inPer1k: 0.5, outPer1k: 1.5 };
  const cachedTokens = Math.min(usage.cachedTokens ?? 0, usage.promptTokens);
  const cacheWriteTokens = Math.min(usage.cacheWriteTokens ?? 0, usage.promptTokens - cachedTokens);
  const plainPromptTokens = usage.promptTokens - cachedTokens - cacheWriteTokens;
  const readRate = rate.inPer1k * (CACHE_READ_MULTIPLIER[providerSlug] ?? 1);
  const writeRate = rate.inPer1k * (CACHE_WRITE_MULTIPLIER[providerSlug] ?? 1);
  const cents =
    (plainPromptTokens / 1000) * rate.inPer1k +
    (cachedTokens / 1000) * readRate +
    (cacheWriteTokens / 1000) * writeRate +
    (usage.completionTokens / 1000) * rate.outPer1k;
  return Math.round(cents * 100) / 100;
}
