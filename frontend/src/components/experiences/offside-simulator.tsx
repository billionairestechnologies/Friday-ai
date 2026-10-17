import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { evaluateOffside, HALFWAY, OFFSIDE_DEFAULTS, PITCH_LENGTH, PITCH_WIDTH, type OffsideParams, type Restart } from "@/lib/experiences/offside";

/**
 * The reference interactive experience (brief §36.3). Every result comes from evaluateOffside() —
 * deterministic code, never a model. Drag the attacker / defender / ball (pointer or touch), use the
 * sliders, or focus a player and press ←/→ (Shift = 0.1 m steps).
 */

const S = 10; // px per metre in the SVG
const X0 = HALFWAY; // the view starts at the halfway line
const toSvg = (x: number) => (x - X0) * S;
const LANES = { ball: 0.3, receiver: 0.38, defender: 0.62, keeper: 0.5 } as const;
type Draggable = "receiverX" | "defenderX" | "ballX";

const RESTARTS: Array<{ value: Restart; label: string }> = [
  { value: "open_play", label: "Open play (a pass)" },
  { value: "throw_in", label: "Throw-in" },
  { value: "corner_kick", label: "Corner kick" },
  { value: "goal_kick", label: "Goal kick" },
];

export function OffsideSimulator({ initial, compact = false, onChange }: { initial?: Partial<OffsideParams>; compact?: boolean; onChange?: (p: OffsideParams) => void }) {
  const start = useMemo(() => ({ ...OFFSIDE_DEFAULTS, ...initial }), [initial]);
  const [p, setP] = useState<OffsideParams>(start);
  const svg = useRef<SVGSVGElement>(null);
  const dragging = useRef<Draggable | null>(null);

  const update = (patch: Partial<OffsideParams>) => {
    setP((prev) => {
      const next = { ...prev, ...patch };
      onChange?.(next);
      return next;
    });
  };
  const r = evaluateOffside({ receiverX: p.receiverX, opponentsX: [p.defenderX, p.goalkeeperX], ballX: p.ballX, involvedInPlay: p.involvedInPlay, restart: p.restart });
  const clampHalf = (x: number) => Math.round(Math.min(PITCH_LENGTH - 0.5, Math.max(X0 - 10, x)) * 10) / 10;

  const fromPointer = (e: PointerEvent) => {
    const el = svg.current;
    if (!el) return null;
    const pt = el.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = el.getScreenCTM();
    if (!ctm) return null;
    return pt.matrixTransform(ctm.inverse()).x / S + X0;
  };
  const onDown = (who: Draggable) => (e: PointerEvent<SVGGElement>) => {
    dragging.current = who;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    const x = fromPointer(e);
    if (x != null) update({ [dragging.current]: clampHalf(x) } as Partial<OffsideParams>);
  };
  const onUp = () => {
    dragging.current = null;
  };
  const onKey = (who: Draggable) => (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.5;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") update({ [who]: clampHalf(p[who] + step) } as Partial<OffsideParams>);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") update({ [who]: clampHalf(p[who] - step) } as Partial<OffsideParams>);
    else return;
    e.preventDefault();
  };

  const W = (PITCH_LENGTH - X0) * S + 40;
  const H = PITCH_WIDTH * S;
  const y = (lane: number) => H * lane;
  const status = !r.inOffsidePosition ? { text: "ONSIDE", tone: "bg-emerald-500 text-white" } : { text: "OFFSIDE POSITION", tone: "bg-amber-500 text-black" };
  const offenceTone = r.offence ? "border-red-500/40 bg-red-500/10 text-red-300 [.light_&]:text-red-700" : "border-border bg-chip text-foreground";

  const player = (who: Draggable | null, x: number, lane: number, fill: string, label: string, aria: string, number?: string) => {
    const cx = toSvg(x);
    const cy = y(lane);
    return (
      <g
        transform={`translate(${cx} ${cy})`}
        {...(who
          ? {
              role: "slider",
              tabIndex: 0,
              "aria-label": aria,
              "aria-valuemin": X0 - 10,
              "aria-valuemax": PITCH_LENGTH,
              "aria-valuenow": x,
              "aria-valuetext": `${x.toFixed(1)} metres from their own goal line`,
              onPointerDown: onDown(who),
              onKeyDown: onKey(who),
              className: "cursor-grab outline-none focus-visible:[&>circle:first-child]:stroke-[#facc15] focus-visible:[&>circle:first-child]:stroke-[5]",
            }
          : {})}
      >
        {who && <circle r={30} fill="transparent" />}
        <circle r={label === "ball" ? 9 : 17} fill={fill} stroke="white" strokeWidth={3} />
        {number && (
          <text textAnchor="middle" dy="0.36em" className="pointer-events-none select-none fill-white text-[15px] font-bold">
            {number}
          </text>
        )}
      </g>
    );
  };

  return (
    <div className={cn("grid gap-4", !compact && "lg:grid-cols-[1fr_320px]")}>
      <div className="min-w-0">
        <div className="overflow-hidden rounded-2xl border border-border bg-[#2f7d3a]">
          <svg
            ref={svg}
            viewBox={`-20 -20 ${W} ${H + 40}`}
            className={cn("mx-auto block h-auto w-full touch-none select-none", compact && "max-h-[380px]")}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            role="group"
            aria-label="Attacking half of a football pitch. Drag the attacker, the defender or the ball."
          >
            {/* Stripes */}
            {Array.from({ length: 6 }, (_, i) => (
              <rect key={i} x={i * ((PITCH_LENGTH - X0) * S) / 6} y={0} width={((PITCH_LENGTH - X0) * S) / 6} height={H} fill={i % 2 ? "#2f7d3a" : "#358a41"} />
            ))}
            <g fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth={3}>
              <rect x={0} y={0} width={(PITCH_LENGTH - X0) * S} height={H} />
              <path d={`M 0 ${H / 2 - 91.5} A 91.5 91.5 0 0 1 0 ${H / 2 + 91.5}`} />
              <rect x={toSvg(PITCH_LENGTH - 16.5)} y={H / 2 - 201.6} width={165} height={403.2} />
              <rect x={toSvg(PITCH_LENGTH - 5.5)} y={H / 2 - 91.6} width={55} height={183.2} />
              <rect x={toSvg(PITCH_LENGTH)} y={H / 2 - 36.6} width={20} height={73.2} />
            </g>
            <text x={6} y={22} className="fill-white/80 text-[16px]">Halfway line</text>
            <text x={toSvg(PITCH_LENGTH) - 6} y={22} textAnchor="end" className="fill-white/80 text-[16px]">Goal →</text>
            {/* The offside line */}
            <line x1={toSvg(r.offsideLineX)} x2={toSvg(r.offsideLineX)} y1={-10} y2={H + 10} stroke="#facc15" strokeWidth={3} strokeDasharray="12 8" />
            <text x={toSvg(r.offsideLineX) + 6} y={H - 10} className="fill-[#facc15] text-[15px] font-semibold">offside line</text>
            {/* Passer next to the ball */}
            {player(null, Math.max(X0 - 8, p.ballX - 2), LANES.ball + 0.06, "#1d4ed8", "passer", "Team-mate passing", "8")}
            {player("ballX", p.ballX, LANES.ball, "#ffffff", "ball", "Ball")}
            {player(null, p.goalkeeperX, LANES.keeper, "#f97316", "keeper", "Goalkeeper", "1")}
            {player("defenderX", p.defenderX, LANES.defender, "#dc2626", "defender", "Second-last defender", "4")}
            {player("receiverX", p.receiverX, LANES.receiver, "#2563eb", "receiver", "Attacker receiving the pass", "9")}
          </svg>
        </div>
        <p className="mt-2 text-xs text-muted">Blue 9 = attacker receiving the pass · Red 4 = defender · Orange 1 = goalkeeper · Yellow dashes = the offside line.</p>
      </div>

      <div className="grid content-start gap-3">
        <div aria-live="polite" className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full px-3 py-1 text-xs font-bold tracking-wide", status.tone)}>{status.text}</span>
            <span className="text-xs text-muted">{r.margin === 0 ? "exactly level" : r.margin > 0 ? `${r.margin.toFixed(1)} m beyond the line` : `${Math.abs(r.margin).toFixed(1)} m onside`}</span>
          </div>
          <p className="text-sm text-foreground">{r.explanation}</p>
          <p className={cn("rounded-xl border px-3 py-2 text-sm", offenceTone)}>{r.offenceExplanation}</p>
        </div>

        {(
          [
            ["receiverX", "Attacker (9)"],
            ["defenderX", "Second-last defender (4)"],
            ["ballX", "Ball, when it's played"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="grid gap-1 text-xs font-medium text-muted">
            <span className="flex justify-between">
              {label} <span className="tabular-nums text-foreground">{p[key].toFixed(1)} m</span>
            </span>
            <input type="range" min={X0 - 10} max={PITCH_LENGTH - 0.5} step={0.1} value={p[key]} onChange={(e) => update({ [key]: Number(e.target.value) } as Partial<OffsideParams>)} aria-label={`${label}, metres from their own goal line`} />
          </label>
        ))}

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => update({ receiverX: r.offsideLineX })} className="rounded-full border border-border px-3 py-1.5 text-xs font-medium hover:bg-chip">
            Level with the line
          </button>
          <button type="button" onClick={() => update({ receiverX: clampHalf(r.offsideLineX + 0.5) })} className="rounded-full border border-border px-3 py-1.5 text-xs font-medium hover:bg-chip">
            Step 0.5 m beyond
          </button>
          <button type="button" onClick={() => (setP(start), onChange?.(start))} className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium hover:bg-chip">
            <RotateCcw className="size-3.5" /> Reset
          </button>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.involvedInPlay} onChange={(e) => update({ involvedInPlay: e.target.checked })} />
          The attacker then plays the ball / interferes
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted">
          How the ball was played
          <select value={p.restart} onChange={(e) => update({ restart: e.target.value as Restart })} className="h-9 rounded-xl border border-border bg-background px-2 text-sm text-foreground">
            {RESTARTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[11px] leading-relaxed text-subtle">
          A simplified learning model of Law 11: each player is one point. Real decisions use the part of the head, body or feet nearest the goal line (arms don't count), the exact moment the ball is played, and the referee's judgement of active involvement.
        </p>
      </div>
    </div>
  );
}
