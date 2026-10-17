import { useEffect, useState } from "react";
import { Building2, FileUp, GraduationCap, Loader2, Rocket, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Help & support → Programmes: apply to the student / startup / company programme, attach evidence,
 * follow the status and answer "we need more information" (GET/POST /api/programs).
 */

type Program = "student" | "startup" | "company";
type Info = { id: Program; title: string; description: string };
type App = {
  id: string;
  program: Program;
  status: "submitted" | "needs_info" | "approved" | "rejected" | "withdrawn" | "expired";
  info_request: string | null;
  decision_note: string | null;
  valid_until: string | null;
  created_at: string;
  evidence: Array<{ id: string; name: string }>;
};
type FileUpload = { name: string; dataUrl: string };

const ICON: Record<Program, typeof GraduationCap> = { student: GraduationCap, startup: Rocket, company: Building2 };
const STATUS: Record<App["status"], { text: string; tone: string }> = {
  submitted: { text: "In review", tone: "bg-amber-500/12 text-amber-600 dark:text-amber-400" },
  needs_info: { text: "We need a bit more", tone: "bg-amber-500/12 text-amber-600 dark:text-amber-400" },
  approved: { text: "Approved", tone: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" },
  rejected: { text: "Not approved", tone: "bg-danger/10 text-danger" },
  withdrawn: { text: "Withdrawn", tone: "bg-chip text-muted" },
  expired: { text: "Ended — apply again to renew", tone: "bg-chip text-muted" },
};

type FieldDef = { key: string; label: string; type?: "text" | "number" | "url" | "textarea" | "select"; options?: string[]; optional?: boolean; placeholder?: string };
const FORMS: Record<Program, FieldDef[]> = {
  student: [
    { key: "institution", label: "College / university" },
    { key: "course", label: "Course", placeholder: "B.Tech Computer Science" },
    { key: "graduationYear", label: "Graduation year", type: "number" },
    { key: "studentId", label: "Student ID number", optional: true },
    { key: "country", label: "Country", optional: true },
  ],
  startup: [
    { key: "companyName", label: "Startup name" },
    { key: "website", label: "Website", type: "url", placeholder: "https://" },
    { key: "description", label: "What you're building", type: "textarea" },
    { key: "teamSize", label: "Team size", type: "number" },
    { key: "stage", label: "Stage", type: "select", options: ["idea", "pre-seed", "seed", "series-a", "later"] },
    { key: "contactRole", label: "Your role", placeholder: "Founder" },
    { key: "founded", label: "Founded (year)", type: "number", optional: true },
  ],
  company: [
    { key: "companyName", label: "Company" },
    { key: "website", label: "Website", type: "url", placeholder: "https://" },
    { key: "teamSize", label: "Company size", type: "number" },
    { key: "seatsNeeded", label: "Seats you need", type: "number" },
    { key: "useCase", label: "What you'll use Friday for", type: "textarea" },
    { key: "contactRole", label: "Your role" },
    { key: "phone", label: "Phone", optional: true },
  ],
};

const field = "w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-foreground/40";

function readFiles(list: FileList | null): Promise<FileUpload[]> {
  return Promise.all(
    [...(list ?? [])].slice(0, 3).map(
      (f) =>
        new Promise<FileUpload>((resolve, reject) => {
          if (f.size > 5 * 1024 * 1024) return reject(new Error(`${f.name} is over 5 MB`));
          const r = new FileReader();
          r.onload = () => resolve({ name: f.name, dataUrl: String(r.result) });
          r.onerror = () => reject(new Error(`Couldn't read ${f.name}`));
          r.readAsDataURL(f);
        }),
    ),
  );
}

function FilePicker({ files, onChange }: { files: FileUpload[]; onChange: (f: FileUpload[]) => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-1.5">
      <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-sm text-muted hover:bg-chip">
        <FileUp className="size-4" /> Attach proof (PDF or image, up to 3 files, 5 MB each)
        <input
          type="file"
          className="sr-only"
          multiple
          accept="application/pdf,image/png,image/jpeg,image/webp"
          onChange={async (e) => {
            setError(null);
            try {
              onChange([...files, ...(await readFiles(e.target.files))].slice(0, 3));
            } catch (err) {
              setError(err instanceof Error ? err.message : "Couldn't read that file");
            }
            e.target.value = "";
          }}
        />
      </label>
      {files.map((f, i) => (
        <span key={`${f.name}-${i}`} className="flex items-center justify-between rounded-lg bg-chip px-3 py-1.5 text-xs">
          {f.name}
          <button type="button" aria-label={`Remove ${f.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))}>
            <X className="size-3.5" />
          </button>
        </span>
      ))}
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}

export function ProgramsPanel() {
  const [data, setData] = useState<{ programs: Info[]; applications: App[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<Program | null>(null);
  const load = () =>
    api
      .get<{ programs: Info[]; applications: App[] }>("/programs")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load programmes"));
  useEffect(() => {
    void load();
  }, []);

  if (!data) return <p className="text-sm text-muted">{error ?? "Loading…"}</p>;
  if (applying) return <ApplyForm program={data.programs.find((p) => p.id === applying)!} onCancel={() => setApplying(null)} onDone={() => (setApplying(null), void load())} />;
  const openFor = (p: Program) => data.applications.some((a) => a.program === p && (a.status === "submitted" || a.status === "needs_info" || a.status === "approved"));

  return (
    <div className="grid gap-4">
      {data.programs.length === 0 && <p className="text-sm text-muted">No programmes are open right now.</p>}
      {data.programs.map((p) => {
        const Icon = ICON[p.id];
        return (
          <div key={p.id} className="flex items-start gap-3 rounded-2xl border border-border p-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-chip">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{p.title}</p>
              <p className="mt-0.5 text-xs text-muted">{p.description}</p>
            </div>
            {!openFor(p.id) && (
              <button type="button" onClick={() => setApplying(p.id)} className="shrink-0 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background">
                Apply
              </button>
            )}
          </div>
        );
      })}
      {data.applications.length > 0 && (
        <div className="grid gap-2">
          <p className="text-xs font-semibold text-muted">Your applications</p>
          {data.applications.map((a) => (
            <ApplicationRow key={a.id} app={a} title={data.programs.find((p) => p.id === a.program)?.title ?? a.program} onChanged={() => void load()} />
          ))}
        </div>
      )}
    </div>
  );
}

function ApplicationRow({ app, title, onChanged }: { app: App; title: string; onChanged: () => void }) {
  const [files, setFiles] = useState<FileUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = STATUS[app.status];
  const post = async (path: string, body: object) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(path, body);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-2xl border border-border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{title}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-xs", s.tone)}>{s.text}</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        Applied {new Date(app.created_at).toLocaleDateString()}
        {app.status === "approved" && app.valid_until ? ` · active until ${new Date(app.valid_until).toLocaleDateString()}` : ""}
      </p>
      {app.decision_note && app.status !== "needs_info" && <p className="mt-2 rounded-xl bg-chip px-3 py-2 text-xs">{app.decision_note}</p>}
      {app.status === "needs_info" && (
        <div className="mt-2 grid gap-2">
          <p className="rounded-xl bg-chip px-3 py-2 text-xs">{app.info_request}</p>
          <FilePicker files={files} onChange={setFiles} />
          <button type="button" disabled={busy || files.length === 0} onClick={() => void post(`/programs/${app.id}/respond`, { files })} className="flex h-9 items-center justify-center gap-2 rounded-full bg-foreground text-xs font-medium text-background disabled:opacity-50">
            {busy && <Loader2 className="size-3.5 animate-spin" />} Send
          </button>
        </div>
      )}
      {(app.status === "submitted" || app.status === "needs_info") && (
        <button type="button" disabled={busy} onClick={() => void post(`/programs/${app.id}/withdraw`, {})} className="mt-2 text-xs text-muted underline">
          Withdraw application
        </button>
      )}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

function ApplyForm({ program, onCancel, onDone }: { program: Info; onCancel: () => void; onDone: () => void }) {
  const defs = FORMS[program.id];
  const [values, setValues] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<FileUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = defs.every((d) => d.optional || (values[d.key] ?? "").trim());
  const submit = async () => {
    setBusy(true);
    setError(null);
    const details = Object.fromEntries(defs.filter((d) => (values[d.key] ?? "").trim()).map((d) => [d.key, d.type === "number" ? Number(values[d.key]) : values[d.key]!.trim()]));
    try {
      await api.post("/programs/apply", { program: program.id, details, files });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send your application");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm font-semibold">{program.title}</p>
      {defs.map((d) => (
        <label key={d.key} className="grid gap-1.5 text-xs font-semibold text-muted">
          <span>
            {d.label}
            {d.optional && <span className="font-normal"> (optional)</span>}
          </span>
          {d.type === "textarea" ? (
            <textarea className={cn(field, "min-h-[80px] py-2")} value={values[d.key] ?? ""} onChange={(e) => setValues({ ...values, [d.key]: e.target.value })} />
          ) : d.type === "select" ? (
            <select className={cn(field, "h-10")} value={values[d.key] ?? ""} onChange={(e) => setValues({ ...values, [d.key]: e.target.value })}>
              <option value="">Choose…</option>
              {d.options!.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input className={cn(field, "h-10")} type={d.type ?? "text"} placeholder={d.placeholder} value={values[d.key] ?? ""} onChange={(e) => setValues({ ...values, [d.key]: e.target.value })} />
          )}
        </label>
      ))}
      <FilePicker files={files} onChange={setFiles} />
      {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className="h-10 flex-1 rounded-full border border-border text-sm">
          Cancel
        </button>
        <button type="submit" disabled={busy || !ready} className="flex h-10 flex-1 items-center justify-center gap-2 rounded-full bg-foreground text-sm font-medium text-background disabled:opacity-50">
          {busy && <Loader2 className="size-4 animate-spin" />} Send application
        </button>
      </div>
      <p className="text-xs text-subtle">Only the Friday team can see what you send here. Files are stored privately.</p>
    </form>
  );
}
