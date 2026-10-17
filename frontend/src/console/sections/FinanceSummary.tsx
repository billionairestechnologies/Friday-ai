import { useState } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge, Button, Card, ErrorNote, Field, Input, Loading, useResource } from "../ui";

/**
 * Console → Finance → Summary (backend services/finance/summary.ts, supabase 0063). Every figure
 * carries its basis — actual (payment records), entered (your expenses), calculated (metered usage ×
 * prices) or estimate (an assumption, named in the formula) — so a projection is never read as fact.
 */

type Basis = "actual" | "entered" | "calculated" | "estimate";
type Metric = { key: string; label: string; value: number | null; unit: "inr" | "pct" | "count"; basis: Basis; formula: string; note?: string };
type Trend = { month: string; cashInr: number; recognisedInr: number; refundsInr: number; costInr: number; opexInr: number };
type Summary = {
  window: { from: string; to: string; days: number };
  metrics: Metric[];
  trend: Trend[];
  reconciliation: Array<{ issue: string; order_id: string | null; amountInr: number; at: string }>;
  reconciliationError: string | null;
  freshness: string;
};

const BASIS: Record<Basis, { tone: string; label: string }> = {
  actual: { tone: "green", label: "actual" },
  entered: { tone: "blue", label: "entered" },
  calculated: { tone: "purple", label: "calculated" },
  estimate: { tone: "amber", label: "estimate" },
};
const today = () => new Date().toISOString().slice(0, 10);
const money = (n: number | null) => (n == null ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`);
const show = (m: Metric) => (m.value == null ? "—" : m.unit === "inr" ? money(m.value) : m.unit === "pct" ? `${m.value.toFixed(1)}%` : m.value.toLocaleString("en-IN"));

const GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: "Cash", keys: ["cash", "refunds", "chargebacks", "netCash", "fees"] },
  { title: "Revenue & profit", keys: ["recognised", "deferred", "aiCost", "sandboxCost", "gross", "grossMargin", "opex", "operating"] },
  { title: "Runway & growth", keys: ["netFlow", "burn", "payers", "arppu", "breakEvenRevenue", "breakEvenCustomers"] },
  { title: "Promotions", keys: ["creditExposure", "creditUsed"] },
];

function MetricCard({ m }: { m: Metric }) {
  const [open, setOpen] = useState(false);
  const b = BASIS[m.basis];
  const negative = m.unit !== "count" && m.value != null && m.value < 0;
  return (
    <Card className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs text-muted">{m.label}</span>
        <Badge tone={b.tone}>{b.label}</Badge>
      </div>
      <span className={cn("text-xl font-semibold tabular-nums", negative && "text-danger")}>{show(m)}</span>
      {m.note && (
        <span className="flex items-start gap-1 text-[11px] text-amber-500">
          <AlertTriangle className="mt-px size-3 shrink-0" /> {m.note}
        </span>
      )}
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-1 self-start text-[11px] text-muted hover:text-foreground">
        <Info className="size-3" /> How it's calculated
      </button>
      {open && <p className="text-[11px] text-muted">{m.formula}</p>}
    </Card>
  );
}

/** Grouped bars per month: cash in, revenue earned, costs (AI + sandbox + fees + expenses). Table below is the accessible source. */
function TrendChart({ rows }: { rows: Trend[] }) {
  const series = [
    { key: "cash", label: "Cash in", color: "#4f8cff", get: (r: Trend) => r.cashInr },
    { key: "earned", label: "Revenue earned", color: "#34d399", get: (r: Trend) => r.recognisedInr },
    { key: "cost", label: "Costs + expenses", color: "#ff6b6b", get: (r: Trend) => r.costInr + r.opexInr },
  ];
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => Math.max(0, s.get(r)))));
  const W = 640;
  const H = 200;
  const pad = 24;
  const group = (W - pad * 2) / Math.max(1, rows.length);
  const bar = Math.min(22, (group - 12) / series.length);
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} /> {s.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H + 24}`} className="h-auto w-full" role="img" aria-label="Cash, revenue earned and costs by month">
        <line x1={pad} x2={W - pad} y1={H} y2={H} stroke="currentColor" strokeOpacity={0.2} />
        {rows.map((r, i) => {
          const x0 = pad + i * group + (group - bar * series.length) / 2;
          return (
            <g key={r.month}>
              {series.map((s, j) => {
                const v = Math.max(0, s.get(r));
                const h = (v / max) * (H - 12);
                return (
                  <rect key={s.key} x={x0 + j * bar} y={H - h} width={bar - 3} height={h} rx={3} fill={s.color}>
                    <title>{`${r.month} · ${s.label}: ${money(s.get(r))}`}</title>
                  </rect>
                );
              })}
              <text x={pad + i * group + group / 2} y={H + 16} textAnchor="middle" className="fill-current text-[11px] text-muted">
                {new Date(`${r.month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" })}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-xs">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">Month</th>
              <th className="py-1 pr-3 text-right font-medium">Cash in</th>
              <th className="py-1 pr-3 text-right font-medium">Refunds</th>
              <th className="py-1 pr-3 text-right font-medium">Earned</th>
              <th className="py-1 pr-3 text-right font-medium">Usage costs</th>
              <th className="py-1 text-right font-medium">Expenses</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr key={r.month} className="border-t border-border/60">
                <td className="py-1 pr-3">{r.month}</td>
                <td className="py-1 pr-3 text-right">{money(r.cashInr)}</td>
                <td className="py-1 pr-3 text-right">{money(r.refundsInr)}</td>
                <td className="py-1 pr-3 text-right">{money(r.recognisedInr)}</td>
                <td className="py-1 pr-3 text-right">{money(r.costInr)}</td>
                <td className="py-1 text-right">{money(r.opexInr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function FinanceSummary() {
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const data = useResource<Summary>(`/console/finance/summary?from=${from}&to=${to}`);
  const s = data.data;
  const byKey = new Map((s?.metrics ?? []).map((m) => [m.key, m]));
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <div className="flex gap-1.5 pb-0.5">
          {[
            { label: "This month", f: `${today().slice(0, 7)}-01` },
            { label: "Last 30 days", f: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10) },
            { label: "This year", f: `${today().slice(0, 4)}-01-01` },
          ].map((p) => (
            <Button key={p.label} size="sm" onClick={() => (setFrom(p.f), setTo(today()))}>
              {p.label}
            </Button>
          ))}
        </div>
      </div>
      <ErrorNote error={data.error} />
      {data.loading && !s ? (
        <Loading label="Building the summary" />
      ) : s ? (
        <>
          <p className="text-xs text-muted">
            {s.window.from} → {s.window.to} ({s.window.days} days) · all amounts in ₹ · as of {new Date(s.freshness).toLocaleString("en-IN")}. Badges: <b>actual</b> = payment records, <b>entered</b> = your expenses, <b>calculated</b> = metered usage × prices, <b>estimate</b> = depends on an assumption.
          </p>
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-2 text-sm font-semibold">{g.title}</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {g.keys.map((k) => byKey.get(k)).filter((m): m is Metric => Boolean(m)).map((m) => (
                  <MetricCard key={m.key} m={m} />
                ))}
              </div>
            </section>
          ))}
          {s.trend.length > 0 && (
            <Card>
              <h3 className="mb-3 text-sm font-semibold">Last {s.trend.length} months</h3>
              <TrendChart rows={s.trend} />
            </Card>
          )}
          <Card>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">Reconciliation · orders vs money received</h3>
            {s.reconciliationError ? (
              <ErrorNote error={s.reconciliationError} />
            ) : s.reconciliation.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-emerald-500">
                <CheckCircle2 className="size-4" /> Every paid order has its payment on record, and every payment matches its order.
              </p>
            ) : (
              <ul className="divide-y divide-border/60 text-sm">
                {s.reconciliation.map((r, i) => (
                  <li key={`${r.order_id}-${i}`} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>
                      <span className="font-mono text-xs">{r.order_id ?? "—"}</span> · {r.issue}
                    </span>
                    <span className="tabular-nums text-muted">{money(r.amountInr)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
