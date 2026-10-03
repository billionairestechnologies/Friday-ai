import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { loadFinanceSettings } from "./pricing.js";

/** Company expenses (servers, tools, salaries, ads, provider top-ups) for the P&L. */

export const EXPENSE_CATEGORIES = [
  { id: "infrastructure", label: "Servers & infrastructure" },
  { id: "hosting", label: "Hosting (EC2, Supabase, CDN, email)" },
  { id: "sandbox", label: "E2B sandboxes (fixed plan fees)" },
  { id: "domains", label: "Domains & DNS" },
  { id: "model_credits", label: "AI provider credits" },
  { id: "software", label: "Software & tools" },
  { id: "salaries", label: "Salaries & contractors" },
  { id: "marketing", label: "Marketing & ads" },
  { id: "office", label: "Office & admin" },
  { id: "legal", label: "Legal & accounting" },
  { id: "taxes", label: "Taxes & fees" },
  { id: "other", label: "Other" },
] as const;

export type Expense = {
  id: string;
  category: string;
  vendor: string;
  description: string;
  amount: number;
  currency: "INR" | "USD";
  amount_inr: number;
  incurred_on: string;
  recurrence: "none" | "monthly" | "yearly";
  payment_method: string;
  reference: string;
  is_model_credits: boolean;
  created_at: string;
};

export type ExpenseInput = {
  category: string;
  vendor?: string;
  description?: string;
  amount: number;
  currency: "INR" | "USD";
  /** Optional: the exact INR the bank charged (USD card spend). Otherwise converted at the books' rate. */
  amountInr?: number | null;
  incurredOn: string;
  recurrence?: "none" | "monthly" | "yearly";
  paymentMethod?: string;
  reference?: string;
};

function toNumberRow(r: Record<string, unknown>): Expense {
  return { ...(r as unknown as Expense), amount: Number(r.amount), amount_inr: Number(r.amount_inr) };
}

export async function listExpenses(filter: { from?: string; to?: string } = {}): Promise<Expense[]> {
  let q = supabaseAdmin.from("expenses").select("*").is("deleted_at", null).order("incurred_on", { ascending: false }).limit(2000);
  // Recurring expenses that started before the window still count inside it, so only bound the end.
  if (filter.to) q = q.lte("incurred_on", filter.to);
  const { data, error } = await q;
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).map((r) => toNumberRow(r as Record<string, unknown>));
}

async function toRow(input: Partial<ExpenseInput>) {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.category !== undefined) {
    if (!EXPENSE_CATEGORIES.some((c) => c.id === input.category)) throw new HttpError(400, "Unknown category");
    row.category = input.category;
    row.is_model_credits = input.category === "model_credits";
  }
  if (input.vendor !== undefined) row.vendor = input.vendor.slice(0, 200);
  if (input.description !== undefined) row.description = input.description.slice(0, 2000);
  if (input.incurredOn !== undefined) row.incurred_on = input.incurredOn;
  if (input.recurrence !== undefined) row.recurrence = input.recurrence;
  if (input.paymentMethod !== undefined) row.payment_method = input.paymentMethod.slice(0, 100);
  if (input.reference !== undefined) row.reference = input.reference.slice(0, 200);
  if (input.amount !== undefined || input.currency !== undefined || input.amountInr !== undefined) {
    if (input.amount === undefined || input.currency === undefined) throw new HttpError(400, "Amount and currency go together");
    row.amount = input.amount;
    row.currency = input.currency;
    if (input.amountInr != null) row.amount_inr = input.amountInr;
    else if (input.currency === "INR") row.amount_inr = input.amount;
    else row.amount_inr = Math.round(input.amount * (await loadFinanceSettings()).usd_to_inr * 100) / 100;
  }
  return row;
}

export async function createExpense(input: ExpenseInput, userId: string): Promise<Expense> {
  const row = { ...(await toRow(input)), created_by: userId };
  const { data, error } = await supabaseAdmin.from("expenses").insert(row).select("*").single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't save the expense");
  return toNumberRow(data as Record<string, unknown>);
}

export async function updateExpense(id: string, input: Partial<ExpenseInput>): Promise<Expense> {
  const { data, error } = await supabaseAdmin.from("expenses").update(await toRow(input)).eq("id", id).is("deleted_at", null).select("*").single();
  if (error || !data) throw new HttpError(error ? 500 : 404, error?.message ?? "Expense not found");
  return toNumberRow(data as Record<string, unknown>);
}

export async function deleteExpense(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("expenses").update({ deleted_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new HttpError(500, error.message);
}

/**
 * How many times an expense is booked inside [from, to] (dates as YYYY-MM-DD): once for a one-off
 * dated inside it; for a recurring one, every monthly/yearly anniversary of its start date that
 * falls inside (a "31st" monthly charge lands on the month's last day in shorter months).
 */
export function occurrencesInWindow(e: Pick<Expense, "incurred_on" | "recurrence">, from: string, to: string): number {
  const start = e.incurred_on.slice(0, 10);
  if (e.recurrence === "none") return start >= from && start <= to ? 1 : 0;
  const [y, m, d] = start.split("-").map(Number) as [number, number, number];
  let count = 0;
  for (let i = 0; i < 1200; i++) {
    const months = e.recurrence === "monthly" ? i : i * 12;
    const year = y + Math.floor((m - 1 + months) / 12);
    const month = ((m - 1 + months) % 12) + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const date = `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
    if (date > to) break;
    if (date >= from) count++;
  }
  return count;
}
