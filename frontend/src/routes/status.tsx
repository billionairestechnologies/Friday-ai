import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, ChevronDown, CircleSlash, Clock, Flag, RefreshCw, X, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { BrandWordmark } from "@/components/brand-mark";
import { ProviderLogo } from "@/components/provider-logos";
import { cn } from "@/lib/utils";

/**
 * /status — public, works signed out. Live component health (probed every 5 minutes), 90-day uptime
 * bars, per-model success rates from real traffic, incidents with their timeline, and a "Report a
 * problem" form that lands in the team's support inbox (and alerts them by email).
 */

type Status = "operational" | "degraded" | "outage" | "unknown";
type Component = { id: string; name: string; group: "Platform" | "Models"; status: Status; latencyMs: number | null; uptime90: number | null; days: { date: string; uptime: number | null }[] };
type Model = { id: string; name: string; provider: string; slug: string; requests24h: number; successRate24h: number | null; status: Status };
type Incident = { id: string; title: string; status: string; impact: string; components: string[]; startedAt: string; resolvedAt: string | null; updates: { id: string; status: string; body: string; createdAt: string }[] };
type StatusResponse = { overall: Status; updatedAt: string | null; components: Component[]; models: Model[]; incidents: { active: Incident[]; recent: Incident[] } };

const TONE: Record<Status, { label: string; dot: string; text: string; bg: string; icon: typeof CheckCircle2 }> = {
  operational: { label: "Operational", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10", icon: CheckCircle2 },
  degraded: { label: "Degraded", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10", icon: AlertTriangle },
  outage: { label: "Outage", dot: "bg-red-500", text: "text-red-600 dark:text-red-400", bg: "bg-red-500/10", icon: XCircle },
  unknown: { label: "No data yet", dot: "bg-zinc-400", text: "text-muted", bg: "bg-chip", icon: CircleSlash },
};

const HEADLINE: Record<Status, string> = {
  operational: "All systems operational",
  degraded: "Some systems are degraded",
  outage: "We're having an outage",
  unknown: "Collecting status data",
};

function barColor(uptime: number | null): string {
  if (uptime == null) return "bg-border";
  if (uptime >= 99.5) return "bg-emerald-500";
  if (uptime >= 97) return "bg-amber-400";
  return "bg-red-500";
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function UptimeBars({ days }: { days: Component["days"] }) {
  return (
    <div className="mt-3 flex h-8 items-stretch gap-[2px]" role="img" aria-label="Daily uptime, last 90 days">
      {days.map((d, i) => (
        <span
          key={d.date}
          title={`${d.date}: ${d.uptime == null ? "no data" : `${d.uptime}% uptime`}`}
          className={cn("min-w-0 flex-1 rounded-[2px] transition-opacity hover:opacity-70", barColor(d.uptime), i < days.length - 45 && "max-sm:hidden")}
        />
      ))}
    </div>
  );
}

function ComponentRow({ c }: { c: Component }) {
  const tone = TONE[c.status];
  return (
    <div className="border-b border-border px-5 py-4 last:border-0">
      <div className="flex items-center gap-3">
        {c.group === "Models" && <ProviderLogo slug={c.id.replace(/^model:/, "")} className="size-4 shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{c.name}</span>
        {c.latencyMs != null && c.status === "operational" && <span className="hidden text-xs text-subtle sm:inline">{c.latencyMs} ms</span>}
        <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", tone.text)}>
          <span className={cn("size-2 rounded-full", tone.dot)} />
          {tone.label}
        </span>
      </div>
      <UptimeBars days={c.days} />
      <div className="mt-1.5 flex justify-between text-[11px] text-subtle">
        <span><span className="max-sm:hidden">90</span><span className="sm:hidden">45</span> days ago</span>
        <span>{c.uptime90 == null ? "—" : `${c.uptime90}% uptime`}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function IncidentCard({ incident, open: startOpen }: { incident: Incident; open?: boolean }) {
  const [open, setOpen] = useState(Boolean(startOpen));
  const resolved = incident.status === "resolved";
  return (
    <div className={cn("rounded-2xl border p-4", resolved ? "border-border" : incident.impact === "critical" || incident.impact === "major" ? "border-red-500/40 bg-red-500/5" : "border-amber-500/40 bg-amber-500/5")}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{incident.title}</div>
          <div className="mt-0.5 text-xs text-muted">
            {resolved ? `Resolved · ${when(incident.resolvedAt ?? incident.startedAt)}` : `${incident.status[0]!.toUpperCase()}${incident.status.slice(1)} · since ${when(incident.startedAt)}`}
          </div>
        </div>
        <ChevronDown className={cn("mt-0.5 size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ol className="mt-3 space-y-3 border-l border-border pl-4">
          {incident.updates.map((u) => (
            <li key={u.id} className="relative">
              <span className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-border" />
              <div className="text-xs font-semibold text-foreground capitalize">{u.status} <span className="font-normal text-subtle">· {when(u.createdAt)}</span></div>
              <p className="mt-0.5 text-sm whitespace-pre-wrap text-muted">{u.body}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ReportDialog({ open, onOpenChange, components }: { open: boolean; onOpenChange: (v: boolean) => void; components: Component[] }) {
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  const [email, setEmail] = useState("");
  const [component, setComponent] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null | false>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDone(false);
      setError(null);
    }
  }, [open]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ ticketNumber: number | null }>("/status/report", {
        ...(signedIn ? {} : { email }),
        component: component || null,
        description,
        url: document.referrer || window.location.href,
      });
      setDone(res.ticketNumber);
      setDescription("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send your report");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content onOpenAutoFocus={(e) => e.preventDefault()} className="fixed top-1/2 left-1/2 z-[70] w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-2xl)] border border-border bg-elevated p-6 shadow-[var(--shadow-panel)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <Dialog.Close className="absolute top-3 right-3 flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground" aria-label="Close">
            <X className="size-4" />
          </Dialog.Close>
          <Dialog.Title className="text-lg font-semibold text-foreground">Report a problem</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">Tell us what went wrong — it goes straight to our team, and we'll email you back.</Dialog.Description>
          {done !== false ? (
            <div className="mt-6 flex flex-col items-center gap-2 py-4 text-center">
              <CheckCircle2 className="size-9 text-emerald-500" />
              <p className="font-medium text-foreground">Thanks — we're on it.</p>
              <p className="text-sm text-muted">{done ? `Your report is ticket #${done}. ` : ""}We sent a confirmation to your email.</p>
              <button type="button" onClick={() => onOpenChange(false)} className="mt-3 h-10 rounded-full border border-border px-5 text-sm font-medium hover:bg-chip">Close</button>
            </div>
          ) : (
            <form
              className="mt-5 grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              {!signedIn && (
                <label className="grid gap-1 text-xs text-muted">
                  Your email
                  <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-foreground/40" />
                </label>
              )}
              <label className="grid gap-1 text-xs text-muted">
                What's affected?
                <select value={component} onChange={(e) => setComponent(e.target.value)} className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground">
                  <option value="">Not sure / something else</option>
                  {components.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs text-muted">
                What happened?
                <textarea
                  required
                  minLength={10}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What you were doing, what you expected, and what happened instead."
                  className="min-h-[120px] rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-foreground/40"
                />
              </label>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <button type="submit" disabled={busy || description.trim().length < 10} className="mt-1 h-11 rounded-full bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50">
                {busy ? "Sending…" : "Send report"}
              </button>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function StatusPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reporting, setReporting] = useState(() => new URLSearchParams(window.location.search).has("report"));

  async function load() {
    setLoading(true);
    try {
      setData(await api.get<StatusResponse>("/status"));
      setFailed(false);
    } catch {
      // If the API itself is down, that IS the status.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const overall: Status = failed ? "outage" : data?.overall ?? "unknown";
  const tone = TONE[overall];
  const platform = useMemo(() => data?.components.filter((c) => c.group === "Platform") ?? [], [data]);
  const providers = useMemo(() => data?.components.filter((c) => c.group === "Models") ?? [], [data]);
  const Icon = tone.icon;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-6 sm:px-6">
        <Link to="/" aria-label="Friday home"><BrandWordmark className="text-xl" /></Link>
        <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-subtle uppercase">Status</span>
        <span className="flex-1" />
        <button type="button" onClick={() => setReporting(true)} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium hover:bg-chip">
          <Flag className="size-3.5" /> Report a problem
        </button>
      </header>

      <main className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
        <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={cn("flex items-center gap-4 rounded-3xl border border-border p-6", tone.bg)}>
          <Icon className={cn("size-9 shrink-0", tone.text)} />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{failed ? "We can't reach Friday right now" : HEADLINE[overall]}</h1>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
              <Clock className="size-3.5" />
              {data?.updatedAt ? `Last checked ${when(data.updatedAt)}` : failed ? "The status service didn't respond" : "Checking…"} · refreshes every minute
            </p>
          </div>
          <button type="button" onClick={() => void load()} aria-label="Refresh" className="flex size-9 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground">
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </button>
        </motion.section>

        {data && data.incidents.active.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-3 text-sm font-semibold text-foreground">Current incidents</h2>
            <div className="grid gap-3">{data.incidents.active.map((i) => <IncidentCard key={i.id} incident={i} open />)}</div>
          </section>
        )}

        {platform.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-3 text-sm font-semibold text-foreground">Platform</h2>
            <div className="overflow-hidden rounded-2xl border border-border bg-elevated">{platform.map((c) => <ComponentRow key={c.id} c={c} />)}</div>
          </section>
        )}

        {providers.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-3 text-sm font-semibold text-foreground">Model providers</h2>
            <div className="overflow-hidden rounded-2xl border border-border bg-elevated">{providers.map((c) => <ComponentRow key={c.id} c={c} />)}</div>
          </section>
        )}

        {data && data.models.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-1 text-sm font-semibold text-foreground">Models</h2>
            <p className="mb-3 text-xs text-muted">Success rate of real requests over the last 24 hours.</p>
            <div className="overflow-hidden rounded-2xl border border-border bg-elevated">
              {data.models.map((m) => {
                const t = TONE[m.status];
                return (
                  <div key={m.id} className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-0">
                    <ProviderLogo slug={m.slug} modelText={`${m.id} ${m.name}`} className="size-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-foreground">{m.name}</div>
                      <div className="truncate text-[11px] text-subtle">{m.provider}</div>
                    </div>
                    <span className="hidden w-28 text-right text-xs text-muted sm:inline">{m.requests24h ? `${m.requests24h.toLocaleString()} requests` : "No traffic"}</span>
                    <span className="w-16 text-right text-xs font-medium text-foreground">{m.successRate24h == null ? "—" : `${m.successRate24h}%`}</span>
                    <span className={cn("size-2 shrink-0 rounded-full", t.dot)} title={t.label} />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Past incidents</h2>
          {data && data.incidents.recent.length > 0 ? (
            <div className="grid gap-3">{data.incidents.recent.map((i) => <IncidentCard key={i.id} incident={i} />)}</div>
          ) : (
            <p className="rounded-2xl border border-dashed border-border px-5 py-6 text-center text-sm text-muted">No incidents in the last 90 days.</p>
          )}
        </section>

        <footer className="mt-12 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-subtle">
          <span>© {new Date().getFullYear()} Billionaires Technologies</span>
          <Link to="/privacy" className="hover:text-foreground">Privacy Policy</Link>
          <Link to="/terms" className="hover:text-foreground">Terms of Service</Link>
          <Link to="/" className="hover:text-foreground">Open Friday</Link>
        </footer>
      </main>
      <ReportDialog open={reporting} onOpenChange={setReporting} components={data?.components ?? []} />
    </div>
  );
}
