import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { loadFinanceSettings } from "./pricing.js";
import { financeReport } from "./report.js";

/**
 * Console → Finance → Summary: the business in one screen, built only from traceable records.
 * Every figure says what it is (`basis`) and how it's computed (`formula`), so an estimate is never
 * read as a fact:
 *
 *   actual      — from the payment ledger (supabase 0063): money received / given back
 *   entered     — from expenses your team recorded
 *   calculated  — metered usage × the prices in Finance → Model pricing
 *   estimate    — depends on an assumption (named in the formula)
 *
 * Cash and revenue are different things: cash is counted when received; revenue is earned
 * straight-line over the period a payment covers (a ₹3,650 annual plan earns ₹10 a day).
 * Promotional credits are never revenue — they appear only as cost exposure.
 */

export type Basis = "actual" | "entered" | "calculated" | "estimate";
export type Metric = { key: string; label: string; value: number | null; unit: "inr" | "pct" | "count"; basis: Basis; formula: string; note?: string };

type RevenueRow = { cash_in: number; refunds: number; chargebacks: number; fees: number; fees_unknown: number; payments: number; payers: number; recognised: number; deferred_at_end: number };

async function revenue(from: string, to: string): Promise<RevenueRow> {
  const { data, error } = await supabaseAdmin.rpc("finance_revenue", { p_from: from, p_to: to });
  if (error) throw new HttpError(500, `Revenue aggregate failed: ${error.message} (is migration 0063 applied?)`);
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  const n = (k: string) => Number(r?.[k] ?? 0);
  return { cash_in: n("cash_in"), refunds: n("refunds"), chargebacks: n("chargebacks"), fees: n("fees"), fees_unknown: n("fees_unknown"), payments: n("payments"), payers: n("payers"), recognised: n("recognised"), deferred_at_end: n("deferred_at_end") };
}

const inr = (paise: number) => Math.round(paise) / 100;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Pure: every derived figure from the raw inputs (unit-tested). */
export function deriveMetrics(input: {
  days: number;
  rev: RevenueRow;
  aiCostInr: number;
  sandboxCostInr: number;
  otherExpensesInr: number;
  unpricedModels: number;
  outstandingCreditTokens: number;
  creditTokensUsed: number;
  blendedCostPerMInr: number;
}): Metric[] {
  const { rev, days } = input;
  const cash = inr(rev.cash_in);
  const refunds = inr(rev.refunds);
  const chargebacks = inr(rev.chargebacks);
  const fees = inr(rev.fees);
  const netCash = cash - refunds - chargebacks;
  const recognised = inr(rev.recognised);
  const variable = input.aiCostInr + input.sandboxCostInr + fees;
  const gross = recognised - variable;
  const grossMargin = recognised > 0 ? (gross / recognised) * 100 : null;
  const operating = gross - input.otherExpensesInr;
  const netFlow = netCash - variable - input.otherExpensesInr;
  const per30 = days > 0 ? 30 / days : 0;
  const arppu = rev.payers > 0 ? (recognised / rev.payers) * per30 : null;
  const fixedMonthly = input.otherExpensesInr * per30;
  const breakEvenRevenue = grossMargin != null && grossMargin > 0 ? fixedMonthly / (grossMargin / 100) : null;
  const breakEvenCustomers = breakEvenRevenue != null && arppu ? Math.ceil(breakEvenRevenue / arppu) : null;
  const costBasis: Basis = input.unpricedModels > 0 ? "estimate" : "calculated";
  const m = (key: string, label: string, value: number | null, unit: Metric["unit"], basis: Basis, formula: string, note?: string): Metric => ({ key, label, value: value == null ? null : r2(value), unit, basis, formula, ...(note ? { note } : {}) });
  return [
    m("cash", "Cash collected", cash, "inr", "actual", "Σ payments received in the window (payment ledger)."),
    m("refunds", "Refunds", refunds, "inr", "actual", "Σ refunds processed in the window."),
    m("chargebacks", "Chargebacks", chargebacks, "inr", "actual", "Σ disputes lost in the window."),
    m("netCash", "Net cash", netCash, "inr", "actual", "Cash collected − refunds − chargebacks."),
    m("fees", "Payment fees", fees, "inr", "actual", "Σ Razorpay fees on payments in the window.", rev.fees_unknown ? `${rev.fees_unknown} payment(s) have no fee on record (paid before the ledger) — not included.` : undefined),
    m("recognised", "Revenue earned", recognised, "inr", "actual", "Each payment spread evenly over the period it covers; the share falling in the window, minus refunds and chargebacks in the window."),
    m("deferred", "Unearned (deferred) revenue", inr(rev.deferred_at_end), "inr", "actual", "Paid for, not yet delivered: the remaining share of every payment's period after the window ends."),
    m("aiCost", "AI provider cost", input.aiCostInr, "inr", costBasis, "Metered tokens × each model's cost price (Finance → Model pricing).", input.unpricedModels ? `${input.unpricedModels} model(s) have no price set — their cost is a list-price estimate.` : undefined),
    m("sandboxCost", "Build sandbox cost", input.sandboxCostInr, "inr", "calculated", "Metered Build sandbox hours × the E2B ₹/hour in finance settings."),
    m("gross", "Gross profit", gross, "inr", costBasis === "estimate" ? "estimate" : "calculated", "Revenue earned − AI provider cost − sandbox cost − payment fees."),
    m("grossMargin", "Gross margin", grossMargin, "pct", costBasis === "estimate" ? "estimate" : "calculated", "Gross profit ÷ revenue earned."),
    m("opex", "Operating expenses", input.otherExpensesInr, "inr", "entered", "Expenses your team recorded for the window (recurring ones counted per occurrence), excluding AI credits bought."),
    m("operating", "Operating profit", operating, "inr", costBasis === "estimate" ? "estimate" : "calculated", "Gross profit − operating expenses."),
    m("netFlow", "Net cash flow", netFlow, "inr", "estimate", "Net cash − (AI + sandbox + fees + operating expenses). Costs are counted when used, not when the supplier is paid."),
    m("burn", "Monthly burn", netFlow < 0 ? -netFlow * per30 : 0, "inr", "estimate", "If net cash flow is negative: its size scaled to 30 days. 0 when cash-positive."),
    m("payers", "Paying customers", rev.payers, "count", "actual", "Distinct people/organisations with a payment in the window."),
    m("arppu", "Revenue per paying customer / month", arppu, "inr", "calculated", "Revenue earned ÷ paying customers, scaled to 30 days."),
    m("breakEvenRevenue", "Break-even revenue / month", breakEvenRevenue, "inr", "estimate", "Operating expenses per 30 days ÷ gross margin — assumes the margin holds as revenue grows."),
    m("breakEvenCustomers", "Break-even paying customers", breakEvenCustomers, "count", "estimate", "Break-even revenue ÷ revenue per paying customer per month."),
    m("creditExposure", "Unspent promotional credits (cost if all used)", (input.outstandingCreditTokens / 1_000_000) * input.blendedCostPerMInr, "inr", "estimate", "Unspent credit-grant tokens × the blended ₹ cost per 1M tokens. Credits are never revenue."),
    m("creditUsed", "Credits used in the window (cost)", (input.creditTokensUsed / 1_000_000) * input.blendedCostPerMInr, "inr", "estimate", "Credit tokens spent in the window × the blended ₹ cost per 1M tokens."),
  ];
}

async function creditFigures(from: string, to: string) {
  const sum = async (q: PromiseLike<{ data: Array<Record<string, unknown>> | null; error: { message: string } | null }>, key: string) => {
    const { data, error } = await q;
    if (error) return 0; // before migration 0060
    return (data ?? []).reduce((n, r) => n + Number(r[key] ?? 0), 0);
  };
  const [outstanding, used] = await Promise.all([
    sum(supabaseAdmin.from("quota_credit_grants").select("remaining").eq("status", "active"), "remaining"),
    sum(supabaseAdmin.from("quota_credit_draws").select("tokens").gte("created_at", from).lt("created_at", to), "tokens"),
  ]);
  return { outstanding, used };
}

/** Whole UTC days: [fromDate 00:00, toDate+1 00:00). */
function window(fromDate: string, toDate: string) {
  const from = `${fromDate}T00:00:00.000Z`;
  const to = new Date(Date.parse(`${toDate}T00:00:00.000Z`) + 86_400_000).toISOString();
  return { from, to, days: Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)) };
}

export async function financeSummary(fromDate: string, toDate: string) {
  const w = window(fromDate, toDate);
  const [rev, report, settings, credits, recon] = await Promise.all([
    revenue(w.from, w.to),
    financeReport(fromDate, toDate),
    loadFinanceSettings(),
    creditFigures(w.from, w.to),
    supabaseAdmin.rpc("finance_reconciliation"),
  ]);
  const metrics = deriveMetrics({
    days: w.days,
    rev,
    aiCostInr: report.totals.aiCostInr,
    sandboxCostInr: report.totals.sandboxCostInr,
    otherExpensesInr: report.totals.otherExpensesInr,
    unpricedModels: report.totals.unpricedModels.length,
    outstandingCreditTokens: credits.outstanding,
    creditTokensUsed: credits.used,
    blendedCostPerMInr: Number(settings.blended_cost_per_m_inr ?? 25),
  });
  return {
    window: { from: fromDate, to: toDate, days: w.days },
    currency: "INR",
    metrics,
    reconciliation: ((recon.data ?? []) as Array<{ issue: string; order_id: string | null; amount_paise: number; at: string }>).slice(0, 50).map((r) => ({ ...r, amountInr: inr(Number(r.amount_paise)) })),
    reconciliationError: recon.error?.message ?? null,
    freshness: new Date().toISOString(),
  };
}

/** Last N calendar months (UTC): cash, revenue earned and costs per month — for the trend chart. */
export async function financeTrend(months = 6) {
  const now = new Date();
  const out: Array<{ month: string; cashInr: number; recognisedInr: number; refundsInr: number; costInr: number; opexInr: number }> = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const last = new Date(end.getTime() - 86_400_000);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const [rev, report] = await Promise.all([revenue(start.toISOString(), end.toISOString()), financeReport(day(start), day(last))]);
    out.push({
      month: day(start).slice(0, 7),
      cashInr: inr(rev.cash_in),
      recognisedInr: inr(rev.recognised),
      refundsInr: inr(rev.refunds + rev.chargebacks),
      costInr: r2(report.totals.aiCostInr + report.totals.sandboxCostInr + inr(rev.fees)),
      opexInr: report.totals.otherExpensesInr,
    });
  }
  return out;
}
