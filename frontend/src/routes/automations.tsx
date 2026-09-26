import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Pause, Play, Plus, Trash2, Workflow, X } from "lucide-react";
import { api } from "@/lib/api";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { cn } from "@/lib/utils";

type Frequency = "hourly" | "daily" | "weekdays" | "weekly";

type Automation = {
  id: string;
  title: string;
  prompt: string;
  frequency: Frequency;
  timeOfDay: string;
  weekday: number | null;
  timezone: string;
  research: boolean;
  enabled: boolean;
  conversationId: string | null;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  running: boolean;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const EXAMPLES = [
  { title: "Morning news brief", prompt: "Give me a short brief of today's top news in India and the world, with sources.", frequency: "daily" as Frequency, timeOfDay: "08:00" },
  { title: "Weekly competitor watch", prompt: "Research what my competitors announced this week and summarise the important moves.", frequency: "weekly" as Frequency, timeOfDay: "09:30" },
  { title: "Unread email digest", prompt: "Summarise my unread emails from the last day and list anything that needs a reply.", frequency: "weekdays" as Frequency, timeOfDay: "09:00" },
];

function describe(a: Pick<Automation, "frequency" | "timeOfDay" | "weekday">): string {
  if (a.frequency === "hourly") return `Every hour at :${a.timeOfDay.slice(3)}`;
  if (a.frequency === "daily") return `Every day at ${a.timeOfDay}`;
  if (a.frequency === "weekdays") return `Weekdays at ${a.timeOfDay}`;
  return `Every ${DAYS[a.weekday ?? 1]} at ${a.timeOfDay}`;
}

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const localTimeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

type Draft = { title: string; prompt: string; frequency: Frequency; timeOfDay: string; weekday: number; research: boolean };
const EMPTY: Draft = { title: "", prompt: "", frequency: "daily", timeOfDay: "09:00", weekday: 1, research: false };

export function AutomationsPage() {
  const navigate = useNavigate();
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  const [items, setItems] = useState<Automation[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api
      .get<{ automations: Automation[] }>("/automations")
      .then((r) => setItems(r.automations))
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load automations"));
  }
  useEffect(() => {
    if (signedIn) load();
  }, [signedIn]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      if (!draft) return;
      const { automation } = await api.post<{ automation: Automation }>("/automations", {
        ...draft,
        weekday: draft.frequency === "weekly" ? draft.weekday : null,
        timezone: localTimeZone,
      });
      setItems((list) => [...(list ?? []), automation]);
      setDraft(null);
    });
  const toggle = (a: Automation) =>
    run(async () => {
      const { automation } = await api.patch<{ automation: Automation }>(`/automations/${a.id}`, { enabled: !a.enabled });
      setItems((list) => (list ?? []).map((x) => (x.id === a.id ? automation : x)));
    });
  const remove = (a: Automation) =>
    run(async () => {
      if (!window.confirm(`Delete “${a.title}”?`)) return;
      await api.delete(`/automations/${a.id}`);
      setItems((list) => (list ?? []).filter((x) => x.id !== a.id));
    });
  const runNow = (a: Automation) =>
    run(async () => {
      await api.post(`/automations/${a.id}/run`);
      setItems((list) => (list ?? []).map((x) => (x.id === a.id ? { ...x, running: true } : x)));
      window.setTimeout(load, 4000);
    });

  return (
    <div className="min-h-dvh bg-background px-4 py-10 text-foreground md:px-8">
      <button
        type="button"
        onClick={() => void navigate({ to: "/" })}
        aria-label="Close"
        className="fixed top-4 right-4 flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-chip hover:text-foreground"
      >
        <X className="size-5" />
      </button>
      <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-10">
        <div className="flex items-start gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-chip">
            <Workflow className="size-5 text-muted" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold">Automations</h1>
            <p className="text-sm text-muted">
              Friday runs these prompts on a schedule in the background, with all its tools (web search, your connectors, code),
              and notifies you. Each automation keeps its own chat so results pile up in one place.
            </p>
          </div>
          {signedIn && !draft && (
            <button
              type="button"
              onClick={() => setDraft({ ...EMPTY })}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-foreground px-4 text-sm font-medium text-background"
            >
              <Plus className="size-4" /> New
            </button>
          )}
        </div>

        {!signedIn && <p className="text-sm text-muted">Sign in to create automations.</p>}
        {error && <p className="text-sm text-danger">{error}</p>}

        {draft && (
          <form
            className="flex flex-col gap-3 rounded-2xl border border-border p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              maxLength={120}
              placeholder="Name, e.g. Morning news brief"
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-foreground/40"
            />
            <textarea
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              maxLength={8000}
              rows={4}
              placeholder="What should Friday do each time?"
              className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/40"
            />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <select
                value={draft.frequency}
                onChange={(e) => setDraft({ ...draft, frequency: e.target.value as Frequency })}
                className="h-9 rounded-lg border border-border bg-background px-2"
              >
                <option value="hourly">Every hour</option>
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Every week</option>
              </select>
              {draft.frequency === "weekly" && (
                <select
                  value={draft.weekday}
                  onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })}
                  className="h-9 rounded-lg border border-border bg-background px-2"
                >
                  {DAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              )}
              <span className="text-muted">{draft.frequency === "hourly" ? "at minute" : "at"}</span>
              <input
                type="time"
                value={draft.timeOfDay}
                onChange={(e) => setDraft({ ...draft, timeOfDay: e.target.value || "09:00" })}
                className="h-9 rounded-lg border border-border bg-background px-2"
              />
              <span className="text-xs text-subtle">{localTimeZone}</span>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.research} onChange={(e) => setDraft({ ...draft, research: e.target.checked })} />
              Deep Research (slower, reads many sources, writes a cited report)
            </label>
            {!draft.title && !draft.prompt && (
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex.title}
                    type="button"
                    onClick={() => setDraft({ ...draft, ...ex })}
                    className="rounded-full bg-chip px-3 py-1 text-xs text-foreground hover:bg-chip/70"
                  >
                    {ex.title}
                  </button>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDraft(null)} className="h-9 rounded-full border border-border px-4 text-sm hover:bg-chip">
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !draft.title.trim() || !draft.prompt.trim()}
                className="h-9 rounded-full bg-foreground px-4 text-sm font-medium text-background disabled:opacity-40"
              >
                Create
              </button>
            </div>
          </form>
        )}

        {signedIn && items && items.length === 0 && !draft && (
          <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted">
            No automations yet — create one to get a daily brief, a weekly report, or an inbox digest delivered automatically.
          </p>
        )}

        <ul className="flex flex-col gap-3">
          {(items ?? []).map((a) => (
            <li key={a.id} className={cn("rounded-2xl border border-border p-4", !a.enabled && "opacity-60")}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{a.title}</p>
                  <p className="text-xs text-muted">
                    {describe(a)} · {a.timezone}
                    {a.research ? " · Deep Research" : ""}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy || a.running}
                  onClick={() => void runNow(a)}
                  className="h-8 rounded-full border border-border px-3 text-xs hover:bg-chip disabled:opacity-40"
                >
                  {a.running ? "Running…" : "Run now"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void toggle(a)}
                  aria-label={a.enabled ? "Pause" : "Resume"}
                  className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground"
                >
                  {a.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(a)}
                  aria-label="Delete"
                  className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-danger"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-muted">{a.prompt}</p>
              <p className="mt-2 text-xs text-subtle">
                {a.enabled ? `Next: ${when(a.nextRunAt)}` : "Paused"} · Last: {when(a.lastRunAt)}
                {a.lastStatus === "error" && <span className="text-danger"> · failed{a.lastError ? `: ${a.lastError}` : ""}</span>}
                {a.lastStatus === "ok" && " · ok — results are in the “⏰ " + a.title + "” chat"}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
