import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Atom, Calculator, Search, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { EXPERIENCES, experienceById, type ExperienceMeta } from "@/lib/experiences/registry";
import { decodeParams, encodeParams, ExperienceView } from "@/components/experiences/experience-view";

/**
 * /gallery — interactive experiences (brief §36). Every card opens the real thing; every number is
 * computed by deterministic code (lib/experiences), never by a model. Public: no account needed.
 */

const ICON = { Sports: Trophy, Finance: Calculator, Science: Atom } as const;
const TINT = { Sports: "from-emerald-500/25 to-emerald-500/5", Finance: "from-amber-500/25 to-amber-500/5", Science: "from-[#4f8cff]/25 to-[#4f8cff]/5" } as const;

function Preview({ e }: { e: ExperienceMeta }) {
  if (e.id === "offside")
    return (
      <svg viewBox="0 0 200 110" className="h-full w-full" aria-hidden>
        <rect width="200" height="110" fill="#2f7d3a" rx="10" />
        <rect x="150" y="25" width="50" height="60" fill="none" stroke="white" strokeOpacity=".7" />
        <line x1="120" x2="120" y1="6" y2="104" stroke="#facc15" strokeWidth="3" strokeDasharray="7 5" />
        <circle cx="128" cy="40" r="8" fill="#2563eb" stroke="white" strokeWidth="2" />
        <circle cx="120" cy="70" r="8" fill="#dc2626" stroke="white" strokeWidth="2" />
        <circle cx="70" cy="32" r="4" fill="white" />
      </svg>
    );
  if (e.id === "emi")
    return (
      <svg viewBox="0 0 200 110" className="h-full w-full" aria-hidden>
        {Array.from({ length: 10 }, (_, i) => {
          const interest = 70 - i * 6;
          const principal = 20 + i * 6;
          return (
            <g key={i}>
              <rect x={14 + i * 18} y={100 - principal} width="12" height={principal} fill="#4f8cff" rx="2" />
              <rect x={14 + i * 18} y={100 - principal - interest} width="12" height={interest} fill="#f59e0b" rx="2" />
            </g>
          );
        })}
      </svg>
    );
  return (
    <svg viewBox="0 0 200 110" className="h-full w-full" aria-hidden>
      <line x1="10" x2="190" y1="100" y2="100" stroke="currentColor" strokeOpacity=".3" />
      <path d="M 12 100 Q 100 -40 188 100" fill="none" stroke="#4f8cff" strokeWidth="4" />
      <path d="M 12 100 Q 70 10 128 100" fill="none" stroke="currentColor" strokeOpacity=".3" strokeWidth="2" strokeDasharray="5 5" />
      <circle cx="188" cy="100" r="5" fill="#f59e0b" />
    </svg>
  );
}

export function GalleryPage() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<"All" | ExperienceMeta["category"]>("All");
  const shown = EXPERIENCES.filter((e) => (cat === "All" || e.category === cat) && `${e.title} ${e.description} ${e.category}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="size-4" /> Friday
        </Link>
        <h1 className="mt-4 font-[var(--font-heading)] text-3xl font-semibold tracking-tight">Interactive gallery</h1>
        <p className="mt-2 max-w-2xl text-muted">Learn by doing. Every result here is calculated by exact rules — move a slider and watch it change. Friday can also open these inside an answer when they help.</p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search experiences" aria-label="Search experiences" className="h-10 w-full rounded-full border border-border bg-background pr-4 pl-9 text-sm outline-none focus:border-foreground/40" />
          </label>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Category">
            {(["All", "Sports", "Finance", "Science"] as const).map((c) => (
              <button key={c} type="button" aria-pressed={cat === c} onClick={() => setCat(c)} className={cn("h-9 rounded-full border px-3 text-sm", cat === c ? "border-foreground bg-foreground text-background" : "border-border hover:bg-chip")}>
                {c}
              </button>
            ))}
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="mt-10 text-center text-sm text-muted">Nothing matches “{q}”. Try another word or category.</p>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((e) => {
              const Icon = ICON[e.category];
              return (
                <Link key={e.id} to="/gallery/$experienceId" params={{ experienceId: e.id }} search={{ p: undefined }} className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-background transition-colors hover:border-foreground/30">
                  <div className={cn("aspect-[16/9] bg-gradient-to-br p-4 text-foreground", TINT[e.category])}>
                    <Preview e={e} />
                  </div>
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <span className="inline-flex w-fit items-center gap-1 rounded-full bg-chip px-2 py-0.5 text-[11px] font-medium text-muted">
                      <Icon className="size-3" /> {e.category}
                    </span>
                    <span className="font-semibold">{e.title}</span>
                    <span className="flex-1 text-sm text-muted">{e.description}</span>
                    <span className="mt-1 inline-flex w-fit rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background group-hover:opacity-90">Try it</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function ExperiencePage() {
  const { experienceId } = useParams({ strict: false }) as { experienceId?: string };
  const navigate = useNavigate();
  const meta = experienceById(experienceId ?? "");
  const initial = useMemo(() => {
    if (!meta) return null;
    const raw = decodeParams(new URLSearchParams(window.location.search).get("p"));
    // A link with bad params opens the defaults instead of failing.
    return meta.parse(raw === null ? undefined : raw) ?? meta.parse(undefined);
  }, [meta]);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  if (!meta || !initial) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
        <p className="text-lg font-semibold">That experience doesn't exist.</p>
        <Link to="/gallery" className="text-sm underline">Back to the gallery</Link>
      </div>
    );
  }
  // Keep the URL in sync (debounced) so the current state can be shared or reopened.
  const onChange = (p: Record<string, unknown>) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void navigate({ to: "/gallery/$experienceId", params: { experienceId: meta.id }, search: { p: encodeParams(p) } as never, replace: true });
    }, 400);
  };
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <Link to="/gallery" className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="size-4" /> Gallery
        </Link>
        <h1 className="mt-3 font-[var(--font-heading)] text-2xl font-semibold tracking-tight sm:text-3xl">{meta.title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">{meta.objective}</p>
        <div className="mt-6">
          <ExperienceView id={meta.id} params={initial} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}
