import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { EMI_DEFAULTS, EMI_LIMITS, schedule, type EmiParams } from "@/lib/experiences/emi";

/** Loan EMI calculator — deterministic (lib/experiences/emi.ts); an estimate, not a lender's offer. */

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

function NumberSlider({ label, value, min, max, step, format, onChange }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted">
      <span className="flex items-center justify-between gap-2">
        {label}
        <input
          type="number"
          aria-label={`${label} (exact value)`}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
          }}
          className="h-7 w-32 rounded-lg border border-border bg-background px-2 text-right text-sm tabular-nums text-foreground"
        />
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-valuetext={format(value)} aria-label={label} />
    </label>
  );
}

export function EmiCalculator({ initial, compact = false, onChange }: { initial?: Partial<EmiParams>; compact?: boolean; onChange?: (p: EmiParams) => void }) {
  const start = useMemo(() => ({ ...EMI_DEFAULTS, ...initial }), [initial]);
  const [p, setP] = useState<EmiParams>(start);
  const set = (patch: Partial<EmiParams>) => setP((prev) => {
    const next = { ...prev, ...patch };
    onChange?.(next);
    return next;
  });
  const s = schedule(p);
  const maxYear = Math.max(1, ...s.years.map((y) => y.principalPaid + y.interestPaid));
  const interestShare = s.totalPaid > 0 ? (s.totalInterest / s.totalPaid) * 100 : 0;
  return (
    <div className={compact ? "grid gap-4" : "grid gap-6 lg:grid-cols-[320px_1fr]"}>
      <div className="grid content-start gap-4">
        <NumberSlider label="Loan amount (₹)" value={p.principal} min={EMI_LIMITS.principal[0]} max={10_000_000} step={10_000} format={inr} onChange={(v) => set({ principal: v })} />
        <NumberSlider label="Interest rate (% a year)" value={p.annualRatePct} min={0} max={EMI_LIMITS.annualRatePct[1]} step={0.05} format={(v) => `${v}%`} onChange={(v) => set({ annualRatePct: v })} />
        <NumberSlider label="Tenure (months)" value={p.months} min={1} max={360} step={1} format={(v) => `${v} months`} onChange={(v) => set({ months: Math.round(v) })} />
        <button type="button" onClick={() => (setP(start), onChange?.(start))} className="inline-flex w-fit items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium hover:bg-chip">
          <RotateCcw className="size-3.5" /> Reset
        </button>
      </div>
      <div className="grid content-start gap-4" aria-live="polite">
        <div className="grid grid-cols-3 gap-2">
          {[
            ["Monthly EMI", inr(s.monthly)],
            ["Total interest", inr(s.totalInterest)],
            ["Total you pay", inr(s.totalPaid)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-2xl border border-border p-3">
              <div className="text-[11px] text-muted">{k}</div>
              <div className="text-base font-semibold tabular-nums sm:text-lg">{v}</div>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted">
          Interest is <b className="text-foreground">{interestShare.toFixed(0)}%</b> of everything you'll pay. Early EMIs are mostly interest; the principal share grows each year as the balance falls.
        </p>
        <div>
          <div className="mb-1 flex gap-4 text-[11px] text-muted">
            <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-[#4f8cff]" /> Principal</span>
            <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-[#f59e0b]" /> Interest</span>
          </div>
          <svg viewBox={`0 0 ${Math.max(1, s.years.length) * 22} 120`} className="h-36 w-full" preserveAspectRatio="none" role="img" aria-label="Principal and interest paid each year">
            {s.years.map((y, i) => {
              const ph = (y.principalPaid / maxYear) * 110;
              const ih = (y.interestPaid / maxYear) * 110;
              return (
                <g key={y.year}>
                  <rect x={i * 22 + 3} y={120 - ph} width={16} height={ph} fill="#4f8cff">
                    <title>{`Year ${y.year}: principal ${inr(y.principalPaid)}`}</title>
                  </rect>
                  <rect x={i * 22 + 3} y={120 - ph - ih} width={16} height={ih} fill="#f59e0b">
                    <title>{`Year ${y.year}: interest ${inr(y.interestPaid)}`}</title>
                  </rect>
                </g>
              );
            })}
          </svg>
          <div className="flex justify-between text-[11px] text-muted">
            <span>Year 1</span>
            <span>Year {s.years.length}</span>
          </div>
        </div>
        <p className="text-[11px] leading-relaxed text-subtle">An estimate using the standard reducing-balance formula. Lenders may add processing fees, insurance or round differently — check your lender's statement before deciding.</p>
      </div>
    </div>
  );
}
