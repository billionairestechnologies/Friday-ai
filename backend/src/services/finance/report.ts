import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { DEFAULT_IMAGE_MODEL } from "../providers/scalemaxImages.js";
import { estimateCostCents } from "../tokenUsage.js";
import { EXPENSE_CATEGORIES, listExpenses, occurrencesInWindow } from "./expenses.js";
import {
  costRatesUsd,
  findPricing,
  hasTokenCost,
  loadFinanceSettings,
  loadPricing,
  priceTokens,
  sellRatesInr,
  type FinanceSettings,
  type ModelPricing,
} from "./pricing.js";

/**
 * The Finance report: per-model economics (what usage cost us vs its value at our prices) and the
 * company P&L (revenue − AI cost − other expenses) for a date window, all in INR.
 *
 * "Value at our prices" is what the usage would bill at the per-1M sell price — the right number for
 * pricing decisions and API/enterprise billing. Subscription revenue is a separate, real number
 * (captured payments); net profit uses real revenue, never the value figure.
 */

type UsageRow = {
  provider_slug: string;
  model_id: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  priced_calls: number;
  priced_cost_usd: number;
  priced_sell_inr: number;
  unpriced_input_tokens: number;
  unpriced_output_tokens: number;
  unpriced_cached_tokens: number;
  unpriced_cache_write_tokens: number;
};

export type ModelLine = {
  provider: string;
  model: string;
  name: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costInr: number;
  valueInr: number;
  marginInr: number;
  /** Margin as % of value (selling price) — null when there is no value to divide by. */
  marginPct: number | null;
  /** "exact": every call priced when made; "current": some priced at today's rate; "estimated": no price row. */
  pricing: "exact" | "current" | "estimated";
  costPerM: { input: number; output: number } | null;
  sellPerM: { input: number; output: number } | null;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 100 : null);

/** Pure: turns aggregated usage rows + prices into report lines (tested without a database). */
export function modelLines(rows: UsageRow[], pricing: ModelPricing[], s: FinanceSettings, legacyEstimateUsd: (row: UsageRow) => number): ModelLine[] {
  return rows
    .map((u) => {
      const price = findPricing(pricing, u.provider_slug, u.model_id);
      const priced = hasTokenCost(price);
      let costUsd = Number(u.priced_cost_usd);
      let valueInr = Number(u.priced_sell_inr);
      const unpricedTokens = Number(u.unpriced_input_tokens) + Number(u.unpriced_output_tokens);
      if (unpricedTokens > 0) {
        if (priced) {
          const p = priceTokens(price, { input: Number(u.unpriced_input_tokens), output: Number(u.unpriced_output_tokens), cached: Number(u.unpriced_cached_tokens), cacheWrite: Number(u.unpriced_cache_write_tokens) }, s);
          costUsd += p.costUsd;
          valueInr += p.sellInr;
        } else {
          costUsd += legacyEstimateUsd(u);
        }
      }
      const costInr = costUsd * s.usd_to_inr;
      const cost = priced ? costRatesUsd(price, s) : null;
      const sell = priced ? sellRatesInr(price, s) : null;
      return {
        provider: u.provider_slug,
        model: u.model_id,
        name: price?.display_name ?? u.model_id,
        calls: Number(u.calls),
        inputTokens: Number(u.input_tokens),
        outputTokens: Number(u.output_tokens),
        cachedTokens: Number(u.cached_tokens),
        costInr: r2(costInr),
        valueInr: r2(valueInr),
        marginInr: r2(valueInr - costInr),
        marginPct: priced ? pct(valueInr - costInr, valueInr) : null,
        pricing: !priced ? "estimated" : unpricedTokens > 0 ? "current" : "exact",
        costPerM: cost ? { input: r2(cost.input * s.usd_to_inr), output: r2(cost.output * s.usd_to_inr) } : null,
        sellPerM: sell ? { input: r2(sell.input), output: r2(sell.output) } : null,
      } satisfies ModelLine;
    })
    .sort((a, b) => b.costInr - a.costInr);
}

async function sumPaid(from: string, to: string): Promise<number> {
  let total = 0;
  for (let offset = 0; offset < 200_000; offset += 1000) {
    const { data, error } = await supabaseAdmin
      .from("razorpay_orders")
      .select("amount_paise")
      .eq("status", "paid")
      .gte("created_at", from)
      .lt("created_at", to)
      .order("created_at")
      .range(offset, offset + 999);
    if (error) throw new HttpError(500, error.message);
    total += (data ?? []).reduce((n, r) => n + Number(r.amount_paise ?? 0), 0);
    if (!data || data.length < 1000) break;
  }
  return total / 100;
}

async function imageCount(from: string, to: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", "image_generation")
    .gte("created_at", from)
    .lt("created_at", to);
  if (error) return 0;
  return count ?? 0;
}

export async function financeReport(fromDate: string, toDate: string) {
  // Whole days in UTC: [from 00:00, to+1 00:00).
  const from = `${fromDate}T00:00:00.000Z`;
  const toExclusive = new Date(new Date(`${toDate}T00:00:00.000Z`).getTime() + 86_400_000).toISOString();
  const [pricing, s, usage, revenueInr, images, expenses] = await Promise.all([
    loadPricing(),
    loadFinanceSettings(),
    supabaseAdmin.rpc("finance_model_usage", { since: from, until: toExclusive }),
    sumPaid(from, toExclusive),
    imageCount(from, toExclusive),
    listExpenses({ to: toDate }),
  ]);
  if (usage.error) throw new HttpError(500, `Usage aggregate failed: ${usage.error.message} (is migration 0040 applied?)`);

  // Calls made before 0040 have no exact cost; they carry the old per-provider estimate in cents,
  // which the aggregate doesn't return — so an unpriced model falls back to a conservative list rate.
  const legacy = (u: UsageRow) =>
    estimateCostCents(u.provider_slug, {
      promptTokens: Number(u.unpriced_input_tokens),
      completionTokens: Number(u.unpriced_output_tokens),
      totalTokens: Number(u.unpriced_input_tokens) + Number(u.unpriced_output_tokens),
      cachedTokens: Number(u.unpriced_cached_tokens),
      cacheWriteTokens: Number(u.unpriced_cache_write_tokens),
    }) / 100;
  const models = modelLines((usage.data ?? []) as UsageRow[], pricing, s, legacy);

  const imageRow = pricing.find((p) => p.model_id === DEFAULT_IMAGE_MODEL) ?? null;
  const imageCostInr = imageRow?.cost_per_image != null ? images * (imageRow.cost_currency === "INR" ? imageRow.cost_per_image : imageRow.cost_per_image * s.usd_to_inr) : null;
  const imageValueInr = imageRow ? (sellRatesInr(imageRow, s).perImage ?? null) : null;

  const byCategory = new Map<string, number>();
  let otherExpensesInr = 0;
  let modelCreditsInr = 0;
  const expenseLines = [];
  for (const e of expenses) {
    const times = occurrencesInWindow(e, fromDate, toDate);
    if (!times) continue;
    const amount = e.amount_inr * times;
    expenseLines.push({ ...e, occurrences: times, totalInr: r2(amount) });
    if (e.is_model_credits) modelCreditsInr += amount;
    else {
      otherExpensesInr += amount;
      byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + amount);
    }
  }

  const aiCostInr = models.reduce((n, m) => n + m.costInr, 0) + (imageCostInr ?? 0);
  const valueInr = models.reduce((n, m) => n + m.valueInr, 0) + (imageValueInr != null ? imageValueInr * images : 0);
  const grossProfit = revenueInr - aiCostInr;
  const netProfit = grossProfit - otherExpensesInr;
  return {
    window: { from: fromDate, to: toDate },
    settings: s,
    models,
    images: { count: images, costInr: imageCostInr != null ? r2(imageCostInr) : null, valuePerImageInr: imageValueInr, priced: imageCostInr != null },
    expenses: expenseLines,
    expensesByCategory: [...byCategory.entries()].map(([category, amountInr]) => ({
      category,
      label: EXPENSE_CATEGORIES.find((c) => c.id === category)?.label ?? category,
      amountInr: r2(amountInr),
    })),
    totals: {
      revenueInr: r2(revenueInr),
      aiCostInr: r2(aiCostInr),
      usageValueInr: r2(valueInr),
      usageMarginPct: pct(valueInr - aiCostInr, valueInr),
      grossProfitInr: r2(grossProfit),
      grossMarginPct: pct(grossProfit, revenueInr),
      otherExpensesInr: r2(otherExpensesInr),
      netProfitInr: r2(netProfit),
      netMarginPct: pct(netProfit, revenueInr),
      modelCreditsBoughtInr: r2(modelCreditsInr),
      unpricedModels: models.filter((m) => m.pricing === "estimated").map((m) => `${m.provider}/${m.model}`),
    },
  };
}
