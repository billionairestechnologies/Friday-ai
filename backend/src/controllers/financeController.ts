import type { Request, Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler.js";
import { recordAdminAuditLog } from "../services/usageService.js";
import { EXPENSE_CATEGORIES, createExpense, deleteExpense, listExpenses, updateExpense } from "../services/finance/expenses.js";
import {
  costRatesUsd,
  deletePricing,
  hasTokenCost,
  loadFinanceSettings,
  loadPricing,
  saveFinanceSettings,
  savePricing,
  sellRatesInr,
  syncListPrices,
} from "../services/finance/pricing.js";
import { financeReport } from "../services/finance/report.js";
import { supabaseAdmin } from "../config/supabase.js";

const id = z.string().uuid();
const money = z.number().min(0).max(1_000_000_000).nullable().optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function audit(req: Request, action: string, targetId: string | null, meta: Record<string, unknown> = {}) {
  void recordAdminAuditLog(req.user!.id, action, "finance", targetId ?? undefined, meta).catch(() => {});
}

/** Every enabled model with its price row (or none yet) and the effective per-1M numbers in INR. */
export async function pricing(_req: Request, res: Response) {
  const [rows, s, models] = await Promise.all([
    loadPricing(),
    loadFinanceSettings(),
    supabaseAdmin.from("provider_models").select("model_id, display_name, is_enabled_for_users, providers(slug)"),
  ]);
  const seen = new Set<string>();
  const out = rows.map((r) => {
    seen.add(`${r.provider_slug}::${r.model_id}`);
    const priced = hasTokenCost(r);
    const cost = priced ? costRatesUsd(r, s) : null;
    const sell = priced ? sellRatesInr(r, s) : null;
    return {
      ...r,
      effective: cost && sell
        ? {
            costInputPerMInr: cost.input * s.usd_to_inr,
            costOutputPerMInr: cost.output * s.usd_to_inr,
            sellInputPerMInr: sell.input,
            sellOutputPerMInr: sell.output,
            sellIsDefault: sell.inputIsDefault || sell.outputIsDefault,
            inputMarginPct: sell.input > 0 ? ((sell.input - cost.input * s.usd_to_inr) / sell.input) * 100 : null,
            outputMarginPct: sell.output > 0 ? ((sell.output - cost.output * s.usd_to_inr) / sell.output) * 100 : null,
          }
        : null,
    };
  });
  // Enabled models with no price row yet — shown so nothing is silently unpriced.
  const missing = (models.data ?? [])
    .filter((m) => m.is_enabled_for_users)
    .map((m) => ({ slug: ((Array.isArray(m.providers) ? m.providers[0] : m.providers) as { slug?: string } | null)?.slug, model_id: m.model_id as string, display_name: m.display_name as string }))
    .filter((m) => m.slug && !seen.has(`${m.slug}::${m.model_id}`));
  res.json({ settings: s, pricing: out, missing });
}

const pricingSchema = z.object({
  provider_slug: z.string().trim().min(1).max(40),
  model_id: z.string().trim().min(1).max(200),
  display_name: z.string().trim().max(200).nullable().optional(),
  cost_currency: z.enum(["USD", "INR"]).optional(),
  cost_input_per_m: money,
  cost_output_per_m: money,
  cost_cache_read_per_m: money,
  cost_cache_write_per_m: money,
  cost_per_image: money,
  cost_source: z.string().trim().max(300).optional(),
  sell_input_per_m_inr: money,
  sell_output_per_m_inr: money,
  sell_per_image_inr: money,
  is_public: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional(),
});

export async function savePrice(req: Request, res: Response) {
  const input = pricingSchema.parse(req.body);
  const row = await savePricing(input, req.user!.id);
  audit(req, "finance.price_saved", row.id, { model: `${row.provider_slug}/${row.model_id}` });
  res.json({ pricing: row });
}

export async function removePrice(req: Request, res: Response) {
  const priceId = id.parse(req.params.priceId);
  await deletePricing(priceId);
  audit(req, "finance.price_deleted", priceId);
  res.status(204).end();
}

export async function syncPrices(req: Request, res: Response) {
  const { force } = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
  const result = await syncListPrices(req.user!.id, Boolean(force));
  audit(req, "finance.prices_synced", null, { updated: result.updated, unmatched: result.unmatched.length });
  res.json(result);
}

export async function settings(req: Request, res: Response) {
  const input = z.object({ usd_to_inr: z.number().optional(), default_markup_pct: z.number().optional() }).parse(req.body);
  const saved = await saveFinanceSettings(input, req.user!.id);
  audit(req, "finance.settings_saved", null, input);
  res.json({ settings: saved });
}

export async function report(req: Request, res: Response) {
  const q = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
  const to = q.to ?? new Date().toISOString().slice(0, 10);
  const from = q.from ?? `${to.slice(0, 7)}-01`;
  if (from > to) throw new HttpError(400, "The start date is after the end date");
  res.json(await financeReport(from, to));
}

const expenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES.map((c) => c.id) as [string, ...string[]]),
  vendor: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  amount: z.number().min(0).max(1_000_000_000),
  currency: z.enum(["INR", "USD"]),
  amountInr: z.number().min(0).max(100_000_000_000).nullable().optional(),
  incurredOn: date,
  recurrence: z.enum(["none", "monthly", "yearly"]).optional(),
  paymentMethod: z.string().trim().max(100).optional(),
  reference: z.string().trim().max(200).optional(),
});

export async function expenses(_req: Request, res: Response) {
  res.json({ expenses: await listExpenses(), categories: EXPENSE_CATEGORIES });
}

export async function addExpense(req: Request, res: Response) {
  const expense = await createExpense(expenseSchema.parse(req.body), req.user!.id);
  audit(req, "finance.expense_added", expense.id, { amountInr: expense.amount_inr, category: expense.category });
  res.status(201).json({ expense });
}

export async function editExpense(req: Request, res: Response) {
  const expenseId = id.parse(req.params.expenseId);
  const expense = await updateExpense(expenseId, expenseSchema.partial().parse(req.body));
  audit(req, "finance.expense_edited", expenseId);
  res.json({ expense });
}

export async function removeExpense(req: Request, res: Response) {
  const expenseId = id.parse(req.params.expenseId);
  await deleteExpense(expenseId);
  audit(req, "finance.expense_deleted", expenseId);
  res.status(204).end();
}
