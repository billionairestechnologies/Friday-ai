import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, FileText, Loader2, Search, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type ProjectFile = {
  id: string;
  filename: string;
  size_bytes: number;
  status: "processing" | "ready" | "error";
  error: string | null;
  chunk_count: number;
  embedded: boolean;
  created_at: string;
};

const ACCEPT = ".pdf,.docx,.xlsx,.pptx,.odt,.ods,.odp,.txt,.md,.csv,.tsv,.json,.xml,.html,.zip,.tar,.gz,.tgz,.rar,.py,.js,.ts,.tsx,.jsx,.java,.go,.rs,.sql,.yaml,.yml,.png,.jpg,.jpeg";
const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Project knowledge: files every chat in this project can search (backend services/knowledge).
 * Indexing runs in the background; the list polls while any file is still processing.
 */
export function ProjectFiles({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ filename: string; content: string }[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api
      .get<{ files: ProjectFile[] }>(`/projects/${projectId}/files`)
      .then((r) => {
        setFiles(r.files);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load files"));
  }, [projectId]);

  useEffect(load, [load]);
  useEffect(() => {
    if (!files?.some((f) => f.status === "processing")) return;
    const t = window.setTimeout(load, 2500);
    return () => window.clearTimeout(t);
  }, [files, load]);

  async function upload(list: FileList | File[]) {
    const chosen = Array.from(list).slice(0, 10);
    if (!chosen.length) return;
    const tooBig = chosen.find((f) => f.size > 20 * 1024 * 1024);
    if (tooBig) {
      setError(`${tooBig.name} is over 20 MB`);
      return;
    }
    const form = new FormData();
    for (const f of chosen) form.append("files", f, f.name);
    setUploading(true);
    try {
      await api.post(`/projects/${projectId}/files`, form);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function search() {
    if (!query.trim()) return setResults(null);
    try {
      const r = await api.get<{ results: { filename: string; content: string }[] }>(`/projects/${projectId}/search?q=${encodeURIComponent(query.trim())}`);
      setResults(r.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    }
  }

  return (
    <section className="mt-4 rounded-2xl border border-border bg-elevated p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Project files</h2>
          <p className="text-xs text-muted">Every chat in this project can search these — PDFs, Word, Excel, slides, code, zips.</p>
        </div>
        <button
          type="button"
          disabled={uploading}
          onClick={() => input.current?.click()}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-medium hover:bg-chip disabled:opacity-60"
        >
          {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Add files
        </button>
        <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }} />
      </div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files); }}
        className={cn("mt-3 rounded-xl border border-dashed border-border p-2 transition-colors", dragging && "border-primary bg-primary/5")}
      >
        {error && <p className="mb-2 flex items-center gap-1.5 px-1 text-xs text-danger"><AlertCircle className="size-3.5" /> {error}</p>}
        {files === null ? (
          <p className="p-3 text-center text-xs text-subtle">Loading…</p>
        ) : files.length === 0 ? (
          <p className="p-4 text-center text-xs text-subtle">Drop files here or use Add files.</p>
        ) : (
          <ul className="flex flex-col">
            {files.map((f) => (
              <li key={f.id} className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-chip/60">
                <FileText className="size-4 shrink-0 text-subtle" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{f.filename}</div>
                  <div className={cn("text-[11px]", f.status === "error" ? "text-danger" : "text-subtle")}>
                    {f.status === "processing" ? "Reading and indexing…" : f.status === "error" ? (f.error ?? "Couldn't read this file") : `${size(f.size_bytes)} · ${f.chunk_count} passages${f.embedded ? "" : " · keyword search"}`}
                  </div>
                </div>
                {f.status === "processing" && <Loader2 className="size-3.5 animate-spin text-subtle" />}
                <button
                  type="button"
                  aria-label={`Remove ${f.filename}`}
                  onClick={async () => {
                    await api.delete(`/projects/${projectId}/files/${f.id}`).catch(() => undefined);
                    load();
                  }}
                  className="flex size-7 items-center justify-center rounded-lg text-subtle opacity-0 hover:bg-elevated hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {files && files.some((f) => f.status === "ready") && (
        <form className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-background px-2.5" onSubmit={(e) => { e.preventDefault(); void search(); }}>
          <Search className="size-4 shrink-0 text-subtle" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Try a search across the files" className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none" />
        </form>
      )}
      {results && (
        <div className="mt-2 flex max-h-72 flex-col gap-2 overflow-y-auto">
          {results.length === 0 ? <p className="text-xs text-subtle">No matches.</p> : results.map((r, i) => (
            <div key={i} className="rounded-lg bg-chip/50 p-2.5 text-xs">
              <div className="mb-1 font-medium">{r.filename}</div>
              <p className="line-clamp-4 whitespace-pre-wrap text-muted">{r.content.replace(/^\[[^\]]+\]\n/, "")}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
