/**
 * Loan EMI (equated monthly instalment), reducing-balance method — the standard formula Indian
 * lenders use: EMI = P·r·(1+r)^n / ((1+r)^n − 1), r = annual rate / 12 / 100, n = months.
 * Deterministic; amounts in rupees, rounded to the paisa only for display. An estimate: lenders add
 * processing fees, insurance and their own rounding.
 */

export type EmiParams = { principal: number; annualRatePct: number; months: number };
export const EMI_DEFAULTS: EmiParams = { principal: 1_000_000, annualRatePct: 9.5, months: 240 };
export const EMI_LIMITS = { principal: [10_000, 100_000_000], annualRatePct: [0, 36], months: [1, 480] } as const;

export function emi({ principal, annualRatePct, months }: EmiParams): number {
  if (months <= 0 || principal <= 0) return 0;
  const r = annualRatePct / 12 / 100;
  if (r === 0) return principal / months;
  const f = Math.pow(1 + r, months);
  return (principal * r * f) / (f - 1);
}

export type YearRow = { year: number; principalPaid: number; interestPaid: number; balance: number };

/** Year-by-year split of what the EMIs pay (principal vs interest) and the balance left. */
export function schedule(p: EmiParams): { monthly: number; totalPaid: number; totalInterest: number; years: YearRow[] } {
  const monthly = emi(p);
  const r = p.annualRatePct / 12 / 100;
  let balance = p.principal;
  const years: YearRow[] = [];
  let row: YearRow = { year: 1, principalPaid: 0, interestPaid: 0, balance };
  for (let m = 1; m <= p.months; m++) {
    const interest = balance * r;
    // Last instalment clears the balance exactly (no floating dust left over).
    const principalPart = m === p.months ? balance : monthly - interest;
    balance -= principalPart;
    row.principalPaid += principalPart;
    row.interestPaid += interest;
    if (m % 12 === 0 || m === p.months) {
      row.balance = Math.max(0, balance);
      years.push(row);
      row = { year: row.year + 1, principalPaid: 0, interestPaid: 0, balance };
    }
  }
  const totalInterest = years.reduce((n, y) => n + y.interestPaid, 0);
  return { monthly, totalPaid: p.principal + totalInterest, totalInterest, years };
}

export function parseEmiParams(raw: unknown): EmiParams | null {
  if (raw == null) return { ...EMI_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out = { ...EMI_DEFAULTS };
  for (const k of ["principal", "annualRatePct", "months"] as const) {
    if (r[k] === undefined) continue;
    const v = Number(r[k]);
    const [lo, hi] = EMI_LIMITS[k];
    if (!Number.isFinite(v) || v < lo || v > hi) return null;
    out[k] = k === "months" ? Math.round(v) : v;
  }
  return out;
}
