/**
 * The data a `friday-chart` block may carry (a model's answer supplies DATA, never code). Validated
 * here and on the server (backend services/chat/experienceBlocks.ts) — anything else falls back to
 * a readable code block.
 */
export type ChartSpec = { type: "bar" | "line"; title?: string; x: string[]; series: Array<{ name: string; values: number[] }>; unit?: string; source?: string };

export const CHART_LIMITS = { points: 60, series: 6, label: 40 } as const;

export function parseChart(raw: unknown): ChartSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "bar" && r.type !== "line") return null;
  if (!Array.isArray(r.x) || r.x.length === 0 || r.x.length > CHART_LIMITS.points) return null;
  const x = r.x.map((v) => String(v).slice(0, CHART_LIMITS.label));
  if (!Array.isArray(r.series) || r.series.length === 0 || r.series.length > CHART_LIMITS.series) return null;
  const series: ChartSpec["series"] = [];
  for (const s of r.series) {
    if (!s || typeof s !== "object") return null;
    const { name, values } = s as { name?: unknown; values?: unknown };
    if (!Array.isArray(values) || values.length !== x.length) return null;
    const nums = values.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return null;
    series.push({ name: String(name ?? "Series").slice(0, CHART_LIMITS.label), values: nums });
  }
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  return { type: r.type, x, series, title: text(r.title, 120), unit: text(r.unit, 20), source: text(r.source, 200) };
}
