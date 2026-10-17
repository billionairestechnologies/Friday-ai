/**
 * Projectile motion on flat ground, no air resistance — the textbook model. Launch and landing at
 * the same height: time = 2v·sinθ/g, range = v²·sin2θ/g, peak = (v·sinθ)²/(2g). Deterministic.
 */

export const GRAVITY = { earth: 9.81, moon: 1.62, mars: 3.71, jupiter: 24.79 } as const;
export type Planet = keyof typeof GRAVITY;
export type ProjectileParams = { speed: number; angleDeg: number; planet: Planet };
export const PROJECTILE_DEFAULTS: ProjectileParams = { speed: 20, angleDeg: 45, planet: "earth" };

export function flight({ speed, angleDeg, planet }: ProjectileParams) {
  const g = GRAVITY[planet];
  const t = (angleDeg * Math.PI) / 180;
  const vx = speed * Math.cos(t);
  const vy = speed * Math.sin(t);
  const time = (2 * vy) / g;
  return { g, time, range: vx * time, peak: (vy * vy) / (2 * g), vx, vy };
}

/** n+1 points along the arc, from launch to landing. */
export function trajectory(p: ProjectileParams, n = 60): Array<{ x: number; y: number }> {
  const f = flight(p);
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = (f.time * i) / n;
    return { x: f.vx * t, y: Math.max(0, f.vy * t - 0.5 * f.g * t * t) };
  });
}

export function parseProjectileParams(raw: unknown): ProjectileParams | null {
  if (raw == null) return { ...PROJECTILE_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out = { ...PROJECTILE_DEFAULTS };
  if (r.speed !== undefined) {
    const v = Number(r.speed);
    if (!Number.isFinite(v) || v < 1 || v > 200) return null;
    out.speed = v;
  }
  if (r.angleDeg !== undefined) {
    const v = Number(r.angleDeg);
    if (!Number.isFinite(v) || v < 1 || v > 89) return null;
    out.angleDeg = v;
  }
  if (r.planet !== undefined) {
    if (!(typeof r.planet === "string" && r.planet in GRAVITY)) return null;
    out.planet = r.planet as Planet;
  }
  return out;
}
