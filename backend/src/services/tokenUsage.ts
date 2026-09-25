export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated?: boolean;
};

export function emptyTokenUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function mergeTokenUsage(a: TokenUsage | null | undefined, b: TokenUsage | null | undefined): TokenUsage {
  const left = a ?? emptyTokenUsage();
  const right = b ?? emptyTokenUsage();
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimated: Boolean(left.estimated || right.estimated),
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
  const cents =
    (usage.promptTokens / 1000) * rate.inPer1k + (usage.completionTokens / 1000) * rate.outPer1k;
  return Math.round(cents * 100) / 100;
}
