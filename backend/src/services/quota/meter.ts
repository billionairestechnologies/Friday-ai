import { effectiveCostRatesUsd, findPricing, loadFinanceSettings, loadPricing } from "../finance/pricing.js";
import { estimateCostCents, type TokenUsage } from "../tokenUsage.js";

/**
 * The usage meter's unit is the CREDIT: what a call really costs us, in 1/100,000 of a US dollar.
 * Plans, windows, org pools and packages are all expressed in credits; users only ever see
 * percentages and reset times.
 *
 * Why not raw tokens (the old unit): one Build turn re-reads its whole transcript every round, so
 * a single website build "used" 1.2M tokens — almost all of it cache reads that cost us a tenth of
 * normal input — and a Haiku token weighed the same as an Opus token (≈50× the price). Pricing the
 * call (cache reads/writes at their own rates, each model at its own price) makes a limit mean the
 * same thing whatever model or feature spent it, and keeps every plan's margin predictable.
 */
export const CREDITS_PER_USD = 100_000;

/** USD per 1M tokens for each token class of one model. */
export type MeterRates = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Credits for one call's usage at `rates`. Rounded up so a real call is never metered as free. */
export function creditsForUsage(usage: TokenUsage, rates: MeterRates): number {
  const prompt = Math.max(0, usage.promptTokens);
  const cached = Math.min(Math.max(0, usage.cachedTokens ?? 0), prompt);
  const written = Math.min(Math.max(0, usage.cacheWriteTokens ?? 0), prompt - cached);
  const plain = prompt - cached - written;
  const usd = (plain * rates.input + cached * rates.cacheRead + written * rates.cacheWrite + Math.max(0, usage.completionTokens) * rates.output) / 1_000_000;
  const credits = usd * CREDITS_PER_USD;
  return credits > 0 ? Math.ceil(credits) : 0;
}

/** Credits for `tokens` of fresh input at `rates` — used for pre-flight estimates. */
export function creditsForInputTokens(tokens: number, rates: MeterRates): number {
  return Math.ceil((Math.max(0, tokens) * rates.input * CREDITS_PER_USD) / 1_000_000);
}

/** Per-provider launch defaults for a model with no row in `model_pricing` (same table the ledger's estimate uses). */
export function fallbackRates(providerSlug: string): MeterRates {
  const per = (u: Partial<TokenUsage>) => estimateCostCents(providerSlug, { promptTokens: 0, completionTokens: 0, totalTokens: 0, ...u }) / 100;
  return {
    input: per({ promptTokens: 1_000_000 }),
    output: per({ completionTokens: 1_000_000 }),
    cacheRead: per({ promptTokens: 1_000_000, cachedTokens: 1_000_000 }),
    cacheWrite: per({ promptTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
  };
}

/** The rates a model is metered at (Console → Finance): the blended supplier rate, the model's own override, or the provider default. Never throws. */
export async function meterRatesFor(providerSlug: string, modelId: string): Promise<MeterRates> {
  try {
    const [rows, settings] = await Promise.all([loadPricing(), loadFinanceSettings()]);
    const row = findPricing(rows, providerSlug, modelId);
    const eff = effectiveCostRatesUsd(row, settings);
    if (eff) return eff.rates;
  } catch {
    /* pricing table unavailable — fall through to the default */
  }
  return fallbackRates(providerSlug);
}

/** Rough tokens → credits for a pre-flight hold when the model isn't known yet (≈ $1 per 1M input tokens). */
export const DEFAULT_RESERVE_RATES: MeterRates = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };
