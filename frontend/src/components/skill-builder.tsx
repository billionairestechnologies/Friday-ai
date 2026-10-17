import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, FlaskConical, Loader2, Plus, RotateCcw, ShieldAlert, Trash2, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Skill Builder (Power Skills, backend supabase 0065 + services/skills/manifest.ts): edit a draft,
 * choose exactly what the skill may use (enforced by the server, not by the skill's text), write test
 * cases, run them, publish a new version only when they pass, roll back to any earlier version.
 */

type Capability = { id: string; label: string; risk: "low" | "medium" | "high" };
type EvalCase = { name: string; prompt: string; mustInclude: string[]; mustNotInclude: string[]; maxChars?: number };
type Manifest = { name: string; description: string; instructions: string; icon: string; capabilities: string[] | null; evals: EvalCase[] };
type EvalResult = { name: string; passed: boolean; failures: string[]; excerpt: string };
type Detail = {
  id: string;
  status: "draft" | "published" | "disabled";
  version: number;
  working: Manifest;
  warnings: string[];
  versions: Array<{ version: number; changelog: string; createdAt: string }>;
  lastEval: { passed: number; total: number; results: EvalResult[]; at: string } | null;
};

const field = "w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/40";
const RISK = { low: "bg-emerald-500/12 text-emerald-600", medium: "bg-amber-500/12 text-amber-600", high: "bg-danger/10 text-danger" } as const;
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export function SkillBuilder({ skillId, onBack, onChanged }: { skillId: string; onBack: () => void; onChanged: () => void }) {
  const [caps, setCaps] = useState<Capability[]>([]);
  const [d, setD] = useState<Detail | null>(null);
  const [m, setM] = useState<Manifest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changelog, setChangelog] = useState("");
  const [results, setResults] = useState<{ passed: number; total: number; results: EvalResult[] } | null>(null);

  const load = async () => {
    const detail = await api.get<Detail>(`/skills/${skillId}/builder`);
    setD(detail);
    setM(detail.working);
    setResults(detail.lastEval);
  };
  useEffect(() => {
    void api.get<{ capabilities: Capability[] }>("/skills/builder/capabilities").then((r) => setCaps(r.capabilities)).catch(() => {});
    void load().catch((e) => setError(e instanceof Error ? e.message : "Couldn't load the skill"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillId]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };
  const saveDraft = () => api.patch<{ warnings: string[] }>(`/skills/${skillId}/draft`, m).then((r) => setD((x) => (x ? { ...x, warnings: r.warnings } : x)));

  if (!d || !m) return <div className="p-6 text-sm text-muted">{error ?? "Loading…"}</div>;
  const declared = m.capabilities ?? ["web", "documents"];
  const setCase = (i: number, patch: Partial<EvalCase>) => setM({ ...m, evals: m.evals.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  return (
    <div className="grid gap-4 p-1">
      <button type="button" onClick={onBack} className="inline-flex w-fit items-center gap-1 text-sm text-muted hover:text-foreground">
        <ArrowLeft className="size-4" /> Back
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg font-semibold">{m.icon} {m.name}</span>
        <span className="rounded-full bg-chip px-2 py-0.5 text-xs text-muted">{d.status === "draft" ? "draft — not live" : d.status === "disabled" ? "disabled" : `live · v${d.version}`}</span>
      </div>

      <label className="grid gap-1 text-xs font-semibold text-muted">Name<input className={field} value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} /></label>
      <label className="grid gap-1 text-xs font-semibold text-muted">When to use it<input className={field} value={m.description} onChange={(e) => setM({ ...m, description: e.target.value })} /></label>
      <label className="grid gap-1 text-xs font-semibold text-muted">Instructions<textarea className={cn(field, "min-h-[140px]")} value={m.instructions} onChange={(e) => setM({ ...m, instructions: e.target.value })} /></label>

      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-xs font-semibold text-muted">What this skill may use — Friday blocks everything else, whatever the instructions say</legend>
        {caps.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={declared.includes(c.id)} onChange={(e) => setM({ ...m, capabilities: e.target.checked ? [...declared, c.id] : declared.filter((x) => x !== c.id) })} />
            <span className="flex-1">{c.label}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px]", RISK[c.risk])}>{c.risk} risk</span>
          </label>
        ))}
      </fieldset>

      {d.warnings.length > 0 && (
        <div className="grid gap-1 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
          {d.warnings.map((w) => (
            <span key={w} className="flex gap-1.5"><ShieldAlert className="size-3.5 shrink-0" /> {w}</span>
          ))}
        </div>
      )}

      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-muted">Test cases (run before publishing)</span>
          <button type="button" onClick={() => setM({ ...m, evals: [...m.evals, { name: `Case ${m.evals.length + 1}`, prompt: "", mustInclude: [], mustNotInclude: [] }] })} className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
            <Plus className="size-3.5" /> Add case
          </button>
        </div>
        {m.evals.map((c, i) => {
          const r = results?.results.find((x) => x.name === c.name);
          return (
            <div key={i} className="grid gap-1.5 rounded-xl border border-border p-3">
              <div className="flex items-center gap-2">
                {r && (r.passed ? <CheckCircle2 className="size-4 text-emerald-500" /> : <XCircle className="size-4 text-danger" />)}
                <input aria-label="Case name" className={cn(field, "py-1")} value={c.name} onChange={(e) => setCase(i, { name: e.target.value })} />
                <button type="button" aria-label="Remove case" onClick={() => setM({ ...m, evals: m.evals.filter((_, j) => j !== i) })}>
                  <Trash2 className="size-4 text-muted" />
                </button>
              </div>
              <textarea aria-label="Test prompt" placeholder="What a user would ask" className={cn(field, "min-h-[56px]")} value={c.prompt} onChange={(e) => setCase(i, { prompt: e.target.value })} />
              <div className="grid gap-1.5 sm:grid-cols-2">
                <textarea aria-label="Must include" placeholder="Answer must include (one per line)" className={cn(field, "min-h-[48px]")} value={c.mustInclude.join("\n")} onChange={(e) => setCase(i, { mustInclude: lines(e.target.value) })} />
                <textarea aria-label="Must not include" placeholder="Answer must NOT include (one per line)" className={cn(field, "min-h-[48px]")} value={c.mustNotInclude.join("\n")} onChange={(e) => setCase(i, { mustNotInclude: lines(e.target.value) })} />
              </div>
              {r && !r.passed && <p className="text-xs text-danger">{r.failures.join(" · ")}</p>}
            </div>
          );
        })}
        {results && <p className={cn("text-xs", results.passed === results.total ? "text-emerald-600" : "text-danger")}>{results.passed} of {results.total} passed on the last run of this draft.</p>}
      </div>

      {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy !== null} onClick={() => void run("save", saveDraft)} className="h-9 rounded-full border border-border px-4 text-sm hover:bg-chip">
          {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : "Save draft"}
        </button>
        <button type="button" disabled={busy !== null || m.evals.length === 0} onClick={() => void run("test", async () => { await saveDraft(); setResults(await api.post(`/skills/${skillId}/evals`, {})); })} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm hover:bg-chip disabled:opacity-50">
          {busy === "test" ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />} Run tests
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="What changed" placeholder="What changed in this version?" className={cn(field, "max-w-xs")} value={changelog} onChange={(e) => setChangelog(e.target.value)} />
        <button type="button" disabled={busy !== null} onClick={() => void run("publish", async () => { await saveDraft(); await api.post(`/skills/${skillId}/publish`, { changelog }); setChangelog(""); await load(); onChanged(); })} className="h-9 rounded-full bg-foreground px-4 text-sm font-medium text-background disabled:opacity-50">
          {busy === "publish" ? <Loader2 className="size-4 animate-spin" /> : `Publish v${d.version + 1}`}
        </button>
        {d.version > 0 && (
          <button type="button" disabled={busy !== null} onClick={() => void run("status", async () => { await api.post(`/skills/${skillId}/status`, { status: d.status === "disabled" ? "published" : "disabled" }); await load(); onChanged(); })} className="h-9 rounded-full px-3 text-sm text-muted hover:bg-chip">
            {d.status === "disabled" ? "Turn back on" : "Disable"}
          </button>
        )}
      </div>

      {d.versions.length > 0 && (
        <div className="grid gap-1">
          <span className="text-xs font-semibold text-muted">Versions</span>
          {d.versions.map((v) => (
            <div key={v.version} className="flex items-center justify-between gap-2 rounded-xl px-2 py-1.5 text-sm hover:bg-chip">
              <span>
                v{v.version} <span className="text-xs text-muted">· {v.changelog || "—"} · {new Date(v.createdAt).toLocaleDateString()}</span>
              </span>
              {v.version !== d.version && (
                <button type="button" disabled={busy !== null} onClick={() => void run(`rb${v.version}`, async () => { await api.post(`/skills/${skillId}/rollback`, { version: v.version }); await load(); onChanged(); })} className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
                  <RotateCcw className="size-3.5" /> Roll back
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
