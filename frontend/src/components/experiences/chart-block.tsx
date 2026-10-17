import { useState } from "react";
import type { ChartSpec } from "@/lib/experiences/chart";

/**
 * A chart from a `friday-chart` block (data validated by parseChart; never code). Bar or line, up
 * to 6 series, a legend, value tooltips, and a "Show data" table — the accessible source of truth.
 */
const COLORS = ["#4f8cff", "#34d399", "#f59e0b", "#a855f7", "#ef4444", "#14b8a6"];

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / p) * p;
}

export function ChartBlock({ spec }: { spec: ChartSpec }) {
  const [table, setTable] = useState(false);
  const all = spec.series.flatMap((s) => s.values);
  const min = Math.min(0, ...all);
  const max = niceMax(Math.max(...all, 0));
  const W = 640;
  const H = 240;
  const L = 48;
  const range = max - min || 1;
  const yOf = (v: number) => H - ((v - min) / range) * H;
  const group = (W - L) / spec.x.length;
  const bw = Math.min(28, (group - 8) / spec.series.length);
  const fmt = (v: number) => `${Math.abs(v) >= 1000 ? v.toLocaleString("en-IN") : Number(v.toFixed(2))}${spec.unit ? ` ${spec.unit}` : ""}`;
  return (
    <figure className="my-3 rounded-2xl border border-border bg-chip/30 p-4">
      {spec.title && <figcaption className="mb-2 text-sm font-semibold text-foreground">{spec.title}</figcaption>}
      <div className="mb-2 flex flex-wrap gap-3 text-xs text-muted">
        {spec.series.map((s, i) => (
          <span key={s.name} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} /> {s.name}
          </span>
        ))}
      </div>
      <svg viewBox={`0 -12 ${W} ${H + 40}`} className="h-auto w-full" role="img" aria-label={spec.title ?? "Chart"}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const v = min + range * t;
          return (
            <g key={t}>
              <line x1={L} x2={W} y1={yOf(v)} y2={yOf(v)} stroke="currentColor" strokeOpacity={0.12} />
              <text x={L - 6} y={yOf(v)} dy="0.32em" textAnchor="end" className="fill-current text-[10px] opacity-60">{fmt(v)}</text>
            </g>
          );
        })}
        {spec.type === "bar"
          ? spec.x.map((label, i) =>
              spec.series.map((s, j) => {
                const v = s.values[i]!;
                const y0 = yOf(Math.max(0, v));
                return (
                  <rect key={`${label}-${s.name}`} x={L + i * group + (group - bw * spec.series.length) / 2 + j * bw} y={y0} width={bw - 2} height={Math.abs(yOf(v) - yOf(0))} rx={3} fill={COLORS[j % COLORS.length]}>
                    <title>{`${label} · ${s.name}: ${fmt(v)}`}</title>
                  </rect>
                );
              }),
            )
          : spec.series.map((s, j) => (
              <g key={s.name}>
                <path d={s.values.map((v, i) => `${i ? "L" : "M"} ${L + i * group + group / 2} ${yOf(v)}`).join(" ")} fill="none" stroke={COLORS[j % COLORS.length]} strokeWidth={2.5} />
                {s.values.map((v, i) => (
                  <circle key={i} cx={L + i * group + group / 2} cy={yOf(v)} r={3.5} fill={COLORS[j % COLORS.length]}>
                    <title>{`${spec.x[i]} · ${s.name}: ${fmt(v)}`}</title>
                  </circle>
                ))}
              </g>
            ))}
        {spec.x.map((label, i) => (
          <text key={label + i} x={L + i * group + group / 2} y={H + 18} textAnchor="middle" className="fill-current text-[10px] opacity-70">
            {spec.x.length > 12 && i % Math.ceil(spec.x.length / 12) ? "" : label}
          </text>
        ))}
      </svg>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
        <span>{spec.source ? `Source: ${spec.source}` : ""}</span>
        <button type="button" onClick={() => setTable((v) => !v)} className="underline-offset-2 hover:underline">
          {table ? "Hide data" : "Show data"}
        </button>
      </div>
      {table && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="text-left">{""}</th>
                {spec.series.map((s) => (
                  <th key={s.name} className="text-right">{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {spec.x.map((label, i) => (
                <tr key={label + i}>
                  <td>{label}</td>
                  {spec.series.map((s) => (
                    <td key={s.name} className="text-right">{fmt(s.values[i]!)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
