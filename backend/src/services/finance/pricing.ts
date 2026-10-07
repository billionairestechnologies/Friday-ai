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
  /** Keep this model's own cost rates even while the blended rate is on (model-wise costing). */
  cost_override?: boolean;
  notes: string;
  updated_at: string;
};

export type FinanceSettings = {
  usd_to_inr: number;
  default_markup_pct: number;
  /** One flat ₹ cost per 1M tokens for every model without an override (supplier deal). 0 = off: each model uses its own price. */
  blended_cost_per_m_inr: number;
  /** The most of a plan's price we'll spend on usage at its caps — drives the suggested limits. */
  target_cost_share_pct: number;
  /** What one Free user may cost us per month. */
  free_cost_budget_inr: number;
  /** E2B sandbox running cost, ₹ per hour of Build time. */
  e2b_cost_per_hour_inr: number;
  /**
   * How a user's plan is consumed. `list` burns by each model's published price, and never slower
   * than the pack rate. `pack` burns every model at the flat supplier rate.
   */
  consumption_basis?: "list" | "pack";
  /** Auto mode steps down to a cheaper model once this share of a quota window is used. */
  conserve_from_pct?: number;
  updated_at?: string;
};

export const FINANCE_DEFAULTS = { blended_cost_per_m_inr: 25, target_cost_share_pct: 40, free_cost_budget_inr: 25, e2b_cost_per_hour_inr: 4.4, consumption_basis: "list" as const, conserve_from_pct: 80 };

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
    cost_override: Boolean(r.cost_override),
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
  // select("*"): a server deployed before migration 0047 still reads the columns that exist.
  const { data } = await supabaseAdmin.from("finance_settings").select("*").maybeSingle();
  return {
    usd_to_inr: Number(data?.usd_to_inr ?? 88),
    default_markup_pct: Number(data?.default_markup_pct ?? 40),
    blended_cost_per_m_inr: Number(data?.blended_cost_per_m_inr ?? FINANCE_DEFAULTS.blended_cost_per_m_inr),
    target_cost_share_pct: Number(data?.target_cost_share_pct ?? FINANCE_DEFAULTS.target_cost_share_pct),
    free_cost_budget_inr: Number(data?.free_cost_budget_inr ?? FINANCE_DEFAULTS.free_cost_budget_inr),
    e2b_cost_per_hour_inr: Number(data?.e2b_cost_per_hour_inr ?? FINANCE_DEFAULTS.e2b_cost_per_hour_inr),
    consumption_basis: data?.consumption_basis === "pack" ? "pack" : "list",
    conserve_from_pct: Number(data?.conserve_from_pct ?? FINANCE_DEFAULTS.conserve_from_pct),
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

export type CostRatesUsd = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * The cost rates a call is metered and booked at. Precedence: a model that has its own price AND the
 * override flag (or no blended rate configured) → its own price; otherwise the flat blended ₹/1M for
 * every token class (cache reads included — the supplier deal doesn't discount them); otherwise the
 * model's own price when it has one; otherwise null (caller falls back to the provider estimate).
 */
export function effectiveCostRatesUsd(row: ModelPricing | null, s: FinanceSettings): { rates: CostRatesUsd; source: "model" | "blended" } | null {
  const own = hasTokenCost(row);
  const blended = s.blended_cost_per_m_inr > 0 ? s.blended_cost_per_m_inr / s.usd_to_inr : 0;
  if (own && (row.cost_override || blended <= 0)) return { rates: costRatesUsd(row, s), source: "model" };
  if (blended > 0) return { rates: { input: blended, output: blended, cacheRead: blended, cacheWrite: blended }, source: "blended" };
  if (own) return { rates: costRatesUsd(row, s), source: "model" };
  return null;
}

/** USD per 1M at the flat pack (₹250 / 10M = ₹25 / 1M). 0 when the pack is switched off. */
export function packUsdPerM(s: FinanceSettings): number {
  return s.blended_cost_per_m_inr > 0 ? s.blended_cost_per_m_inr / s.usd_to_inr : 0;
}

/**
 * The rates a user's plan burns at. These are the cost fields saved in Team Console → Finance,
 * the same numbers on the model row. `effectiveCostRatesUsd` is separate: that is what we pay,
 * which stays the pack unless the row's own-cost switch is on.
 * With basis `pack`, every model burns the flat supplier rate instead.
 */
export function consumptionRatesUsd(row: ModelPricing | null, s: FinanceSettings): { rates: CostRatesUsd; source: "list" | "pack" | "model" } | null {
  const pack = packUsdPerM(s);
  const own = hasTokenCost(row);
  const basis = s.consumption_basis === "pack" ? "pack" : "list";
  if (basis === "list" && own) return { rates: costRatesUsd(row, s), source: row.cost_override ? "model" : "list" };
  if (pack > 0) return { rates: { input: pack, output: pack, cacheRead: pack, cacheWrite: pack }, source: "pack" };
  if (own) return { rates: costRatesUsd(row, s), source: "list" };
  return null;
}

/** How many pack-tokens one input token of this model costs the plan. 1 = the pack rate. */
export function consumptionWeight(row: ModelPricing | null, s: FinanceSettings): number {
  const pack = packUsdPerM(s);
  const rates = consumptionRatesUsd(row, s);
  if (!rates || pack <= 0) return 1;
  return rates.rates.input / pack;
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
function costAt(rates: CostRatesUsd, t: TokenCounts): number {
  const cached = Math.min(t.cached, t.input);
  const written = Math.min(t.cacheWrite, t.input - cached);
  return round(((t.input - cached - written) * rates.input + cached * rates.cacheRead + written * rates.cacheWrite + t.output * rates.output) / 1_000_000, 8);
}

/** Prices one call for the ledger. `costUsd` is what we pay (the pack, unless the model overrides it). `listCostUsd` is the published price of the same tokens. */
export async function priceUsage(providerSlug: string, modelId: string, usage: TokenUsage): Promise<{ costUsd: number; sellInr: number | null; priced: boolean; listCostUsd: number | null }> {
  try {
    const [rows, s] = await Promise.all([loadPricing(), loadFinanceSettings()]);
    const row = findPricing(rows, providerSlug, modelId);
    const eff = effectiveCostRatesUsd(row, s);
    const t = { input: usage.promptTokens, output: usage.completionTokens, cached: usage.cachedTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0 };
    const listCostUsd = hasTokenCost(row) ? costAt(costRatesUsd(row, s), t) : null;
    if (eff) {
      if (eff.source === "model" && hasTokenCost(row)) {
        const p = priceTokens(row, t, s);
        return { costUsd: p.costUsd, sellInr: p.sellInr, priced: true, listCostUsd };
      }
      const costUsd = costAt(eff.rates, t);
      // Value at our prices: the model's own sell rates when it has them, else cost × markup.
      const sellInr = hasTokenCost(row) ? priceTokens(row, t, s).sellInr : round(costUsd * s.usd_to_inr * (1 + s.default_markup_pct / 100), 6);
      return { costUsd, sellInr, priced: true, listCostUsd };
    }
  } catch {
    /* pricing table unavailable — fall through to the estimate */
  }
  return { costUsd: estimateCostCents(providerSlug, usage) / 100, sellInr: null, priced: false, listCostUsd: null };
}

// ── Admin editing ─────────────────────────────────────────────────────────────────────────────

export type PricingInput = Partial<Omit<ModelPricing, "id" | "updated_at">> & { provider_slug: string; model_id: string };

const EDITABLE: (keyof PricingInput)[] = [
  "display_name", "cost_currency", "cost_input_per_m", "cost_output_per_m", "cost_cache_read_per_m", "cost_cache_write_per_m",
  "cost_per_image", "cost_source", "sell_input_per_m_inr", "sell_output_per_m_inr", "sell_per_image_inr", "is_public", "notes", "cost_override",
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
  const bounded = (key: keyof FinanceSettings, min: number, max: number, label: string) => {
    const v = input[key];
    if (v === undefined) return;
    if (typeof v !== "number" || !(v >= min && v <= max)) throw new HttpError(400, `${label} must be between ${min} and ${max}`);
    row[key] = v;
  };
  bounded("blended_cost_per_m_inr", 0, 100_000, "Blended cost per 1M tokens");
  bounded("target_cost_share_pct", 1, 100, "Target cost share");
  bounded("free_cost_budget_inr", 0, 100_000, "Free-user cost budget");
  bounded("e2b_cost_per_hour_inr", 0, 10_000, "E2B cost per hour");
  bounded("conserve_from_pct", 50, 100, "Conserve-from percent");
  if (input.consumption_basis !== undefined) {
    if (input.consumption_basis !== "list" && input.consumption_basis !== "pack") throw new HttpError(400, "Consumption basis is list or pack");
    row.consumption_basis = input.consumption_basis;
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
