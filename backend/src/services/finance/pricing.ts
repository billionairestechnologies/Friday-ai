import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { memoAsync } from "../../utils/ttlMemo.js";
import { estimateCostCents, type TokenUsage } from "../tokenUsage.js";

/**
 * Model economics: what each model costs us per 1M tokens (from whoever we buy it from) and what we
 * charge per 1M tokens, priced exactly per call. All money math lives here as pure functions so it
 * is testable and every screen (ledger, admin report, public price list) uses the same numbers.
 */

export type ModelPricing = {
  id: string;
  provider_slug: string;
  model_id: string;
  display_name: string | null;
  cost_currency: "USD" | "INR";
  cost_input_per_m: number | null;
  cost_output_per_m: number | null;
  cost_cache_read_per_m: number | null;
  cost_cache_write_per_m: number | null;
  cost_per_image: number | null;
  cost_source: string;
  sell_input_per_m_inr: number | null;
  sell_output_per_m_inr: number | null;
  sell_per_image_inr: number | null;
  is_public: boolean;
  notes: string;
  updated_at: string;
};

export type FinanceSettings = { usd_to_inr: number; default_markup_pct: number; updated_at?: string };

/** Provider-published cache economics, used only when a model row leaves the cache price empty. */
const CACHE_READ_DEFAULT: Record<string, number> = { anthropic: 0.1, scalemax: 0.1, openai: 0.5, openrouter: 0.5, gemini: 0.25 };
const CACHE_WRITE_DEFAULT: Record<string, number> = { anthropic: 1.25, scalemax: 1.25 };

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function normalizeRow(r: Record<string, unknown>): ModelPricing {
  return {
    ...(r as unknown as ModelPricing),
    cost_input_per_m: num(r.cost_input_per_m),
    cost_output_per_m: num(r.cost_output_per_m),
    cost_cache_read_per_m: num(r.cost_cache_read_per_m),
    cost_cache_write_per_m: num(r.cost_cache_write_per_m),
    cost_per_image: num(r.cost_per_image),
    sell_input_per_m_inr: num(r.sell_input_per_m_inr),
    sell_output_per_m_inr: num(r.sell_output_per_m_inr),
    sell_per_image_inr: num(r.sell_per_image_inr),
  };
}

export const loadPricing = memoAsync(60_000, async (): Promise<ModelPricing[]> => {
  const { data, error } = await supabaseAdmin.from("model_pricing").select("*").order("provider_slug").order("model_id");
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).map((r) => normalizeRow(r as Record<string, unknown>));
});

export const loadFinanceSettings = memoAsync(60_000, async (): Promise<FinanceSettings> => {
  const { data } = await supabaseAdmin.from("finance_settings").select("usd_to_inr, default_markup_pct, updated_at").maybeSingle();
  return {
    usd_to_inr: Number(data?.usd_to_inr ?? 88),
    default_markup_pct: Number(data?.default_markup_pct ?? 40),
    updated_at: (data?.updated_at as string | undefined) ?? undefined,
  };
});

export function invalidatePricing() {
  // Both take no arguments, so their single cache key is JSON.stringify([]).
  loadPricing.invalidate("[]");
  loadFinanceSettings.invalidate("[]");
}

/**
 * The same model has different ids in different places: "claude-sonnet-4-5-20250929" (Anthropic),
 * "anthropic/claude-sonnet-4.5" (OpenRouter), "claude-sonnet-4.5:thinking". Reduced to one key.
 */
export function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .trim()
    .replace(/^[\w.-]+\//, "")
    .replace(/:[\w-]+$/, "")
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .replace(/-latest$/, "")
    .replace(/\./g, "-");
}

/** The pricing row for a model: exact provider+id first, then the same normalized id. */
export function findPricing(rows: ModelPricing[], providerSlug: string, modelId: string): ModelPricing | null {
  const exact = rows.find((r) => r.provider_slug === providerSlug && r.model_id === modelId);
  if (exact) return exact;
  const key = normalizeModelId(modelId);
  return rows.find((r) => r.provider_slug === providerSlug && normalizeModelId(r.model_id) === key) ?? null;
}

const costToUsd = (row: ModelPricing, amount: number, s: FinanceSettings) => (row.cost_currency === "INR" ? amount / s.usd_to_inr : amount);

/** Has the row enough cost data to price a token call? */
export function hasTokenCost(row: ModelPricing | null): row is ModelPricing {
  return Boolean(row && row.cost_input_per_m != null && row.cost_output_per_m != null);
}

/** Effective cost per 1M tokens in USD for each token class (cache prices fall back to the provider's ratio). */
export function costRatesUsd(row: ModelPricing, s: FinanceSettings) {
  const input = costToUsd(row, row.cost_input_per_m ?? 0, s);
  const output = costToUsd(row, row.cost_output_per_m ?? 0, s);
  const cacheRead = row.cost_cache_read_per_m != null ? costToUsd(row, row.cost_cache_read_per_m, s) : input * (CACHE_READ_DEFAULT[row.provider_slug] ?? 1);
  const cacheWrite = row.cost_cache_write_per_m != null ? costToUsd(row, row.cost_cache_write_per_m, s) : input * (CACHE_WRITE_DEFAULT[row.provider_slug] ?? 1);
  return { input, output, cacheRead, cacheWrite };
}

/** What we charge per 1M tokens in INR: the explicit sell price, or cost × FX × (1 + default markup). */
export function sellRatesInr(row: ModelPricing, s: FinanceSettings) {
  const cost = costRatesUsd(row, s);
  const markup = 1 + s.default_markup_pct / 100;
  return {
    input: row.sell_input_per_m_inr ?? round(cost.input * s.usd_to_inr * markup, 4),
    output: row.sell_output_per_m_inr ?? round(cost.output * s.usd_to_inr * markup, 4),
    perImage: row.sell_per_image_inr ?? (row.cost_per_image != null ? round(costToUsd(row, row.cost_per_image, s) * s.usd_to_inr * markup, 4) : null),
    inputIsDefault: row.sell_input_per_m_inr == null,
    outputIsDefault: row.sell_output_per_m_inr == null,
  };
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export type TokenCounts = { input: number; output: number; cached: number; cacheWrite: number };

/**
 * Exact economics of token usage. `input` includes the cached and cache-write tokens (that's how
 * every provider reports prompt tokens); they're split out and priced at their own rates. Sell price
 * applies per prompt token regardless of caching — the cache saving is our margin, not a discount.
 */
export function priceTokens(row: ModelPricing, t: TokenCounts, s: FinanceSettings): { costUsd: number; sellInr: number } {
  const cost = costRatesUsd(row, s);
  const sell = sellRatesInr(row, s);
  const cached = Math.min(t.cached, t.input);
  const cacheWrite = Math.min(t.cacheWrite, t.input - cached);
  const plain = t.input - cached - cacheWrite;
  const costUsd = (plain * cost.input + cached * cost.cacheRead + cacheWrite * cost.cacheWrite + t.output * cost.output) / 1_000_000;
  const sellInr = (t.input * sell.input + t.output * sell.output) / 1_000_000;
  return { costUsd: round(costUsd, 8), sellInr: round(sellInr, 6) };
}

/** Prices one call for the ledger. Unpriced models keep the old per-provider estimate, flagged. */
export async function priceUsage(providerSlug: string, modelId: string, usage: TokenUsage): Promise<{ costUsd: number; sellInr: number | null; priced: boolean }> {
  try {
    const [rows, s] = await Promise.all([loadPricing(), loadFinanceSettings()]);
    const row = findPricing(rows, providerSlug, modelId);
    if (hasTokenCost(row)) {
      const p = priceTokens(row, { input: usage.promptTokens, output: usage.completionTokens, cached: usage.cachedTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0 }, s);
      return { costUsd: p.costUsd, sellInr: p.sellInr, priced: true };
    }
  } catch {
    /* pricing table unavailable — fall through to the estimate */
  }
  return { costUsd: estimateCostCents(providerSlug, usage) / 100, sellInr: null, priced: false };
}

// ── Admin editing ─────────────────────────────────────────────────────────────────────────────

export type PricingInput = Partial<Omit<ModelPricing, "id" | "updated_at">> & { provider_slug: string; model_id: string };

const EDITABLE: (keyof PricingInput)[] = [
  "display_name", "cost_currency", "cost_input_per_m", "cost_output_per_m", "cost_cache_read_per_m", "cost_cache_write_per_m",
  "cost_per_image", "cost_source", "sell_input_per_m_inr", "sell_output_per_m_inr", "sell_per_image_inr", "is_public", "notes",
];

export async function savePricing(input: PricingInput, userId: string): Promise<ModelPricing> {
  const row: Record<string, unknown> = { provider_slug: input.provider_slug, model_id: input.model_id, updated_by: userId, updated_at: new Date().toISOString() };
  for (const key of EDITABLE) if (input[key] !== undefined) row[key] = input[key];
  for (const key of ["cost_input_per_m", "cost_output_per_m", "cost_cache_read_per_m", "cost_cache_write_per_m", "cost_per_image", "sell_input_per_m_inr", "sell_output_per_m_inr", "sell_per_image_inr"]) {
    if (key in row && row[key] !== null && (!Number.isFinite(Number(row[key])) || Number(row[key]) < 0)) throw new HttpError(400, `${key} must be a non-negative number`);
  }
  const { data, error } = await supabaseAdmin.from("model_pricing").upsert(row, { onConflict: "provider_slug,model_id" }).select("*").single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't save the price");
  invalidatePricing();
  return normalizeRow(data as Record<string, unknown>);
}

export async function deletePricing(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("model_pricing").delete().eq("id", id);
  if (error) throw new HttpError(500, error.message);
  invalidatePricing();
}

export async function saveFinanceSettings(input: Partial<FinanceSettings>, userId: string): Promise<FinanceSettings> {
  const row: Record<string, unknown> = { id: true, updated_by: userId, updated_at: new Date().toISOString() };
  if (input.usd_to_inr !== undefined) {
    if (!(input.usd_to_inr > 1 && input.usd_to_inr < 1000)) throw new HttpError(400, "USD → INR rate looks wrong");
    row.usd_to_inr = input.usd_to_inr;
  }
  if (input.default_markup_pct !== undefined) {
    if (!(input.default_markup_pct >= 0 && input.default_markup_pct <= 1000)) throw new HttpError(400, "Markup must be between 0 and 1000%");
    row.default_markup_pct = input.default_markup_pct;
  }
  const { error } = await supabaseAdmin.from("finance_settings").upsert(row);
  if (error) throw new HttpError(500, error.message);
  invalidatePricing();
  return loadFinanceSettings();
}

// ── List-price sync ───────────────────────────────────────────────────────────────────────────

type OpenRouterModel = { id: string; name?: string; pricing?: Record<string, string | undefined> };

/** USD per token (OpenRouter's unit) → USD per 1M tokens; null when absent or negative ("-1" = variable). */
export function perMillion(v: string | undefined): number | null {
  const n = Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) || n < 0 ? null : round(n * 1_000_000, 6);
}

/**
 * Picks the OpenRouter entry for one of our models. OpenRouter lists most labs' models under
 * vendor/name ids, so it doubles as a public list-price source for OpenAI/Anthropic/Google models.
 */
export function matchOpenRouter(models: OpenRouterModel[], providerSlug: string, modelId: string): OpenRouterModel | null {
  if (providerSlug === "openrouter") return models.find((m) => m.id === modelId) ?? null;
  const vendor = providerSlug === "gemini" ? "google" : providerSlug;
  const key = normalizeModelId(modelId);
  const sameKey = models.filter((m) => normalizeModelId(m.id) === key && !/:(free|beta)$/.test(m.id));
  return sameKey.find((m) => m.id.startsWith(`${vendor}/`)) ?? sameKey[0] ?? null;
}

/**
 * Fills every enabled model's COST price from OpenRouter's public list prices. A row whose cost
 * came from somewhere else (an invoice, a reseller rate typed by the admin) is never overwritten
 * unless `force` — that number is more accurate than a list price for what WE actually pay.
 */
export async function syncListPrices(userId: string, force = false): Promise<{ updated: number; unmatched: string[]; skipped: string[] }> {
  const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new HttpError(502, `OpenRouter price list unavailable (${res.status})`);
  const models = ((await res.json()) as { data?: OpenRouterModel[] }).data ?? [];
  const { data: enabled, error } = await supabaseAdmin.from("provider_models").select("model_id, display_name, providers(slug)").eq("is_enabled_for_users", true);
  if (error) throw new HttpError(500, error.message);
  const existing = await loadPricing();
  let updated = 0;
  const unmatched: string[] = [];
  const skipped: string[] = [];
  for (const m of enabled ?? []) {
    const provider = (Array.isArray(m.providers) ? m.providers[0] : m.providers) as { slug?: string } | null;
    const slug = provider?.slug;
    if (!slug) continue;
    const modelId = m.model_id as string;
    const current = existing.find((r) => r.provider_slug === slug && r.model_id === modelId);
    if (current && !force && current.cost_source && !current.cost_source.startsWith("OpenRouter")) {
      skipped.push(`${slug}/${modelId}`);
      continue;
    }
    const hit = matchOpenRouter(models, slug, modelId);
    const p = hit?.pricing;
    const input = perMillion(p?.prompt);
    const output = perMillion(p?.completion);
    if (!hit || input == null || output == null) {
      unmatched.push(`${slug}/${modelId}`);
      if (!current) await savePricing({ provider_slug: slug, model_id: modelId, display_name: (m.display_name as string) ?? null }, userId);
      continue;
    }
    await savePricing(
      {
        provider_slug: slug,
        model_id: modelId,
        display_name: (m.display_name as string) ?? hit.name ?? null,
        cost_currency: "USD",
        cost_input_per_m: input,
        cost_output_per_m: output,
        cost_cache_read_per_m: perMillion(p?.input_cache_read),
        cost_cache_write_per_m: perMillion(p?.input_cache_write),
        cost_source: `OpenRouter list price (${hit.id}), ${new Date().toISOString().slice(0, 10)}`,
      },
      userId,
    );
    updated++;
  }
  return { updated, unmatched, skipped };
}

/** The public price list (models marked is_public), in INR per 1M tokens. */
export async function publicPriceList() {
  const [rows, s] = await Promise.all([loadPricing(), loadFinanceSettings()]);
  return rows
    .filter((r) => r.is_public && hasTokenCost(r))
    .map((r) => {
      const sell = sellRatesInr(r, s);
      return { provider: r.provider_slug, model: r.model_id, name: r.display_name ?? r.model_id, inputPerMInr: sell.input, outputPerMInr: sell.output };
    });
}
