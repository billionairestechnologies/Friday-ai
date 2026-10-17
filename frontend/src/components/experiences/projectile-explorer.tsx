import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { flight, GRAVITY, PROJECTILE_DEFAULTS, trajectory, type Planet, type ProjectileParams } from "@/lib/experiences/projectile";

/** Projectile motion — deterministic (lib/experiences/projectile.ts): flat ground, no air resistance. */

const PLANETS: Array<{ id: Planet; label: string }> = [
  { id: "earth", label: "Earth" },
  { id: "moon", label: "Moon" },
  { id: "mars", label: "Mars" },
  { id: "jupiter", label: "Jupiter" },
];

export function ProjectileExplorer({ initial, compact = false, onChange }: { initial?: Partial<ProjectileParams>; compact?: boolean; onChange?: (p: ProjectileParams) => void }) {
  const start = useMemo(() => ({ ...PROJECTILE_DEFAULTS, ...initial }), [initial]);
  const [p, setP] = useState<ProjectileParams>(start);
  const set = (patch: Partial<ProjectileParams>) => setP((prev) => {
    const next = { ...prev, ...patch };
    onChange?.(next);
    return next;
  });
  const f = flight(p);
  const best = flight({ ...p, angleDeg: 45 });
  const arc = trajectory(p);
  const ghost = p.angleDeg !== 45 ? trajectory({ ...p, angleDeg: 45 }) : null;
  const xMax = Math.max(best.range, f.range) * 1.05;
  const yMax = Math.max(flight({ ...p, angleDeg: 89 }).peak * 0.5, f.peak) * 1.15 || 1;
  const W = 600;
  const H = 280;
  const path = (pts: Array<{ x: number; y: number }>) => pts.map((pt, i) => `${i ? "L" : "M"} ${(pt.x / xMax) * W} ${H - (pt.y / yMax) * H}`).join(" ");
  const m = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} km` : `${n.toFixed(1)} m`);
  return (
    <div className={compact ? "grid gap-4" : "grid gap-6 lg:grid-cols-[1fr_300px]"}>
      <div className="min-w-0">
        <svg viewBox={`-10 -10 ${W + 20} ${H + 30}`} className="h-auto w-full rounded-2xl border border-border bg-chip/40" role="img" aria-label={`Trajectory: range ${m(f.range)}, peak ${m(f.peak)}`}>
          <line x1={0} x2={W} y1={H} y2={H} stroke="currentColor" strokeOpacity={0.3} />
          {ghost && <path d={path(ghost)} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2} strokeDasharray="6 6" />}
          <path d={path(arc)} fill="none" stroke="#4f8cff" strokeWidth={4} strokeLinecap="round" />
          <circle cx={(f.range / xMax) * W} cy={H} r={6} fill="#f59e0b" />
          <text x={(f.range / xMax) * W} y={H + 20} textAnchor="middle" className="fill-current text-[12px]">{m(f.range)}</text>
          {ghost && <text x={(best.range / xMax) * W} y={H - (best.peak / yMax) * H - 8} textAnchor="middle" className="fill-current text-[11px] opacity-60">45°</text>}
        </svg>
        <p className="mt-2 text-xs text-muted">Dashed arc = the same throw at 45°, for comparison.</p>
      </div>
      <div className="grid content-start gap-4">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Gravity">
          {PLANETS.map((pl) => (
            <button key={pl.id} type="button" role="radio" aria-checked={p.planet === pl.id} onClick={() => set({ planet: pl.id })} className={cn("rounded-full border px-3 py-1 text-xs font-medium", p.planet === pl.id ? "border-foreground bg-foreground text-background" : "border-border hover:bg-chip")}>
              {pl.label} · {GRAVITY[pl.id]} m/s²
            </button>
          ))}
        </div>
        {(
          [
            ["speed", "Launch speed", 1, 100, 0.5, "m/s"],
            ["angleDeg", "Launch angle", 1, 89, 1, "°"],
          ] as const
        ).map(([key, label, min, max, step, unit]) => (
          <label key={key} className="grid gap-1 text-xs font-medium text-muted">
            <span className="flex justify-between">
              {label} <span className="tabular-nums text-foreground">{p[key]} {unit}</span>
            </span>
            <input type="range" min={min} max={max} step={step} value={p[key]} onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<ProjectileParams>)} aria-label={label} />
          </label>
        ))}
        <dl className="grid grid-cols-3 gap-2 text-center" aria-live="polite">
          {[
            ["Range", m(f.range)],
            ["Peak", m(f.peak)],
            ["Flight", `${f.time.toFixed(2)} s`],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-border p-2">
              <dt className="text-[11px] text-muted">{k}</dt>
              <dd className="text-sm font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-muted">
          {p.angleDeg === 45 ? "45° gives the longest range when you launch and land at the same height." : p.angleDeg < 45 ? `Lower than 45°: faster forward, but it lands sooner. ${90 - p.angleDeg}° would land at exactly the same spot.` : `Higher than 45°: more hang time, less distance. ${90 - p.angleDeg}° would land at exactly the same spot.`}
        </p>
        <button type="button" onClick={() => (setP(start), onChange?.(start))} className="inline-flex w-fit items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium hover:bg-chip">
          <RotateCcw className="size-3.5" /> Reset
        </button>
        <p className="text-[11px] text-subtle">Textbook model: flat ground, no air resistance or spin — a real ball falls short of these numbers.</p>
      </div>
    </div>
  );
}
