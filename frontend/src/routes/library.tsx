import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Code2, Copy, Download, ExternalLink, FileStack, Globe, ImageIcon, LayoutGrid, LibraryBig, Loader2, MessageSquare, Paperclip, Search, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { FileIcon, FORMAT_STYLE, downloadGeneratedFile, formatBytes } from "@/components/file-card";
import { cn } from "@/lib/utils";
import { useEscape } from "@/lib/use-dismiss";

/**
 * The Library: everything Friday made for this user and everything they shared, in one organised
 * place — generated documents, images, code, web pages and their uploads. Private to the signed-in
 * user (every API call is owner-scoped). Documents count against the plan's Library storage.
 */

type LibraryItem = {
  id: string;
  source: "artifact" | "document" | "upload";
  conversation_id: string | null;
  title: string;
  kind: string;
  lang: string | null;
  category: string;
  created_at: string;
  preview: string;
  size?: number;
  filename?: string;
  mime?: string;
  content?: string;
};

type Section = "all" | "documents" | "images" | "code" | "pages" | "uploads";

const CODE_CATEGORIES = new Set(["React", "Python", "JavaScript / TypeScript", "Shell", "SQL", "Styles", "Data", "Other code"]);

function sectionOf(item: LibraryItem): Exclude<Section, "all"> {
  if (item.source === "document") return "documents";
  if (item.source === "upload") return "uploads";
  if (item.kind === "image") return "images";
  if (item.category === "Web pages") return "pages";
  return "code";
}

const SECTIONS: { id: Section; label: string; icon: typeof LayoutGrid }[] = [
  { id: "all", label: "All", icon: LayoutGrid },
  { id: "documents", label: "Documents", icon: FileStack },
  { id: "images", label: "Images", icon: ImageIcon },
  { id: "code", label: "Code", icon: Code2 },
  { id: "pages", label: "Web pages", icon: Globe },
  { id: "uploads", label: "Uploads", icon: Paperclip },
];

const EXTENSIONS: Record<string, string> = {
  html: "html", python: "py", py: "py", javascript: "js", js: "js", typescript: "ts", ts: "ts",
  jsx: "jsx", tsx: "tsx", css: "css", scss: "scss", bash: "sh", sh: "sh", shell: "sh", sql: "sql",
  json: "json", yaml: "yml", yml: "yml", xml: "xml", csv: "csv", java: "java", r: "r", go: "go",
  rust: "rs", c: "c", cpp: "cpp", php: "php", ruby: "rb", swift: "swift", kotlin: "kt",
};

function fileNameFor(item: LibraryItem) {
  const base = item.title.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) || "friday";
  if (item.kind === "image") return `${base}.png`;
  const ext = EXTENSIONS[(item.lang ?? "").toLowerCase()] ?? (item.kind === "react" ? "jsx" : item.kind === "html" ? "html" : "txt");
  return `${base}.${ext}`;
}

async function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function when(iso: string) {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function LibraryPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [storage, setStorage] = useState<{ usedBytes: number; limitBytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<LibraryItem | null>(null);
  useEscape(Boolean(open), () => setOpen(null));
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    api
      .get<{ items: LibraryItem[] }>("/library")
      .then((res) => {
        setItems(res.items.map((i) => ({ ...i, source: i.source ?? "artifact" })));
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load your library"));
    api.get<{ storage: { usedBytes: number; limitBytes: number } }>("/files").then((r) => setStorage(r.storage)).catch(() => {});
  }
  useEffect(load, []);

  const counts = useMemo(() => {
    const map = new Map<Section, number>([["all", items?.length ?? 0]]);
    for (const item of items ?? []) map.set(sectionOf(item), (map.get(sectionOf(item)) ?? 0) + 1);
    return map;
  }, [items]);

  const q = query.trim().toLowerCase();
  const visible = (items ?? []).filter((item) => (section === "all" || sectionOf(item) === section) && (!q || `${item.title} ${item.lang ?? ""} ${item.category} ${item.filename ?? ""}`.toLowerCase().includes(q)));

  async function openItem(item: LibraryItem) {
    setCopied(false);
    setOpenUrl(null);
    setOpen(item);
    try {
      if (item.source === "artifact" && item.kind !== "image") {
        const res = await api.get<{ item: LibraryItem }>(`/library/${item.id}`);
        setOpen({ ...res.item, source: "artifact" });
      } else if (item.source === "upload") {
        const res = await api.get<{ url: string }>(`/library/uploads/${item.id}`);
        setOpenUrl(res.url);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open that item");
      setOpen(null);
    }
  }

  async function downloadItem(item: LibraryItem) {
    setBusy(item.id);
    try {
      if (item.source === "document") await downloadGeneratedFile(item.id, item.filename ?? `${item.title}.${item.lang ?? "bin"}`);
      else if (item.source === "upload") {
        const url = openUrl ?? (await api.get<{ url: string }>(`/library/uploads/${item.id}`)).url;
        await saveBlob(await (await fetch(url)).blob(), item.title);
      } else if (item.kind === "image") await saveBlob(await (await fetch(item.preview)).blob(), fileNameFor(item));
      else {
        const content = item.content ?? (await api.get<{ item: LibraryItem }>(`/library/${item.id}`)).item.content ?? item.preview;
        await saveBlob(new Blob([content], { type: "text/plain;charset=utf-8" }), fileNameFor(item));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't download that file");
    } finally {
      setBusy(null);
    }
  }

  async function remove(item: LibraryItem) {
    if (!window.confirm(`Delete "${item.title}" from your library?`)) return;
    try {
      await api.delete(item.source === "document" ? `/files/${item.id}` : `/library/${item.id}`);
      setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? prev);
      setOpen(null);
      if (item.source === "document") api.get<{ storage: { usedBytes: number; limitBytes: number } }>("/files").then((r) => setStorage(r.storage)).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that item");
    }
  }

  const body = open ? (open.kind === "image" ? open.preview : (open.content ?? open.preview)) : "";
  const storagePct = storage && storage.limitBytes > 0 ? Math.min(100, Math.round((storage.usedBytes / storage.limitBytes) * 100)) : 0;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <button
        type="button"
        onClick={() => void navigate({ to: "/" })}
        aria-label="Close"
        className="fixed top-4 right-4 z-10 flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-chip hover:text-foreground"
      >
        <X className="size-5" />
      </button>

      <div className="mx-auto flex max-w-6xl gap-8 px-4 py-8 md:px-8">
        <aside className="hidden w-52 shrink-0 md:block">
          <div className="sticky top-8">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-xl bg-chip"><LibraryBig className="size-4.5 text-muted" /></div>
              <h1 className="text-lg font-semibold">Library</h1>
            </div>
            <nav className="mt-6 flex flex-col gap-0.5">
              {SECTIONS.map((s) => {
                const Icon = s.icon;
                const on = section === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSection(s.id)}
                    className={cn("relative flex h-9 items-center gap-2.5 rounded-xl px-3 text-sm transition-colors", on ? "text-foreground" : "text-muted hover:bg-chip hover:text-foreground")}
                  >
                    {on && <motion.span layoutId="library-nav" className="absolute inset-0 rounded-xl bg-chip-on" transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} />}
                    <Icon className="relative size-4" />
                    <span className="relative flex-1 text-left">{s.label}</span>
                    <span className="relative text-xs text-subtle tabular-nums">{counts.get(s.id) ?? 0}</span>
                  </button>
                );
              })}
            </nav>
            {storage && (
              <div className="mt-8 rounded-2xl border border-border p-3">
                <div className="flex justify-between text-xs text-muted"><span>Storage</span><span>{storagePct}%</span></div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-chip">
                  <div className={cn("h-full rounded-full transition-all", storagePct > 90 ? "bg-red-500" : storagePct > 70 ? "bg-amber-500" : "bg-search")} style={{ width: `${Math.max(2, storagePct)}%` }} />
                </div>
                <div className="mt-1.5 text-[11px] text-subtle">{formatBytes(storage.usedBytes)} of {formatBytes(storage.limitBytes)}</div>
              </div>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <div className="flex items-center gap-2 md:hidden">
            <div className="flex size-9 items-center justify-center rounded-xl bg-chip"><LibraryBig className="size-4.5 text-muted" /></div>
            <h1 className="text-lg font-semibold">Library</h1>
          </div>
          <p className="mt-1 text-sm text-muted md:mt-0">Documents, images, code and files from your chats — saved automatically, only visible to you.</p>

          <div className="mt-5 flex items-center gap-2 rounded-2xl border border-border bg-composer px-3.5">
            <Search className="size-4 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your library" className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-subtle" />
          </div>

          <div className="scroll-thin mt-3 flex gap-2 overflow-x-auto pb-1 md:hidden">
            {SECTIONS.map((s) => (
              <button key={s.id} type="button" onClick={() => setSection(s.id)} className={cn("shrink-0 rounded-full px-3 py-1.5 text-sm transition-colors", section === s.id ? "bg-foreground text-background" : "bg-chip text-muted")}>
                {s.label} <span className="opacity-60">{counts.get(s.id) ?? 0}</span>
              </button>
            ))}
          </div>

          {error && <div className="mt-4 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}

          {items === null && !error && (
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-48 animate-pulse rounded-2xl bg-chip/60" />)}
            </div>
          )}
          {items && visible.length === 0 && (
            <div className="mt-12 flex flex-col items-center text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-chip"><LibraryBig className="size-5 text-muted" /></div>
              <p className="mt-3 text-sm font-medium">{items.length === 0 ? "Your Library is empty" : "Nothing matches"}</p>
              <p className="mt-1 max-w-sm text-sm text-muted">{items.length === 0 ? "Ask Friday for a presentation, spreadsheet, report, image or code — everything it makes lands here." : "Try another search or section."}</p>
            </div>
          )}

          <motion.div layout className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <AnimatePresence initial={false}>
              {visible.map((item) => (
                <motion.button
                  layout
                  key={`${item.source}:${item.id}`}
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.18 }}
                  type="button"
                  onClick={() => (item.source === "document" ? void downloadItem(item) : void openItem(item))}
                  className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-composer text-left transition-colors hover:border-foreground/25"
                >
                  <Thumb item={item} busy={busy === item.id} />
                  <div className="flex items-start gap-2 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{item.source === "document" ? item.filename : item.title}</div>
                      <div className="mt-0.5 truncate text-xs text-muted">
                        {item.source === "document"
                          ? `${FORMAT_STYLE[item.lang ?? ""]?.label ?? item.lang} · ${item.preview} · ${formatBytes(item.size ?? 0)}`
                          : item.source === "upload"
                            ? `Uploaded · ${formatBytes(item.size ?? 0)}`
                            : item.category}
                        {" · "}
                        {when(item.created_at)}
                      </div>
                    </div>
                  </div>
                </motion.button>
              ))}
            </AnimatePresence>
          </motion.div>
        </main>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(null)}>
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="flex max-h-[88dvh] w-full max-w-4xl flex-col rounded-[var(--radius-2xl)] border border-border bg-background p-4 shadow-[var(--shadow-panel)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{open.title}</div>
                  <div className="text-xs text-muted">{open.source === "upload" ? "Your upload" : open.category} · {when(open.created_at)}</div>
                </div>
                {open.conversation_id && (
                  <button type="button" onClick={() => void navigate({ to: "/c/$conversationId", params: { conversationId: open.conversation_id! } })} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-chip hover:text-foreground">
                    <MessageSquare className="size-4" /> Open chat
                  </button>
                )}
                {open.source === "artifact" && open.kind !== "image" && (
                  <button type="button" onClick={() => void navigator.clipboard.writeText(body).then(() => setCopied(true))} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-chip hover:text-foreground">
                    <Copy className="size-4" /> {copied ? "Copied" : "Copy"}
                  </button>
                )}
                {open.source === "upload" && openUrl && (
                  <a href={openUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-chip hover:text-foreground">
                    <ExternalLink className="size-4" /> Open
                  </a>
                )}
                <button type="button" onClick={() => void downloadItem(open)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-chip hover:text-foreground">
                  {busy === open.id ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Download
                </button>
                {open.source !== "upload" && (
                  <button type="button" onClick={() => void remove(open)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-danger hover:bg-danger/10">
                    <Trash2 className="size-4" /> Delete
                  </button>
                )}
                <button type="button" onClick={() => setOpen(null)} aria-label="Close" className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip">
                  <X className="size-4" />
                </button>
              </div>
              <div className="mt-3 min-h-0 flex-1 overflow-auto">
                {open.source === "upload" ? (
                  !openUrl ? (
                    <div className="grid h-40 place-items-center"><Loader2 className="size-5 animate-spin text-muted" /></div>
                  ) : open.kind === "image" ? (
                    <img src={openUrl} alt={open.title} className="mx-auto max-h-[68dvh] rounded-xl" />
                  ) : (
                    <div className="grid h-40 place-items-center text-sm text-muted">Preview isn't available for this file type — download it to open.</div>
                  )
                ) : open.kind === "image" ? (
                  <img src={body} alt={open.title} className="mx-auto max-h-[68dvh] rounded-xl" />
                ) : open.kind === "html" ? (
                  <iframe title={open.title} sandbox="allow-scripts" srcDoc={body} className="h-[62dvh] w-full rounded-xl border border-border bg-white" />
                ) : (
                  <pre className="scroll-thin overflow-auto rounded-xl bg-chip p-4 font-mono text-xs leading-relaxed">{body}</pre>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Thumb({ item, busy }: { item: LibraryItem; busy: boolean }) {
  if (item.source === "document") {
    const style = FORMAT_STYLE[item.lang ?? ""] ?? FORMAT_STYLE.txt!;
    return (
      <div className="relative flex h-32 items-center justify-center" style={{ background: style.bg }}>
        <FileIcon format={item.lang ?? "txt"} className="size-14" />
        <span className="absolute top-2.5 right-2.5 flex size-8 items-center justify-center rounded-full bg-background/80 text-muted opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        </span>
      </div>
    );
  }
  if (item.kind === "image" && item.source === "artifact") return <img src={item.preview} alt={item.title} className="h-32 w-full object-cover" loading="lazy" />;
  if (item.source === "upload") {
    return (
      <div className="flex h-32 items-center justify-center bg-chip/60 text-muted">
        {item.kind === "image" ? <ImageIcon className="size-8" strokeWidth={1.25} /> : <Paperclip className="size-8" strokeWidth={1.25} />}
      </div>
    );
  }
  return (
    <div className="relative h-32 overflow-hidden bg-chip/60">
      <pre className="h-full overflow-hidden p-3 font-mono text-[10.5px] leading-relaxed text-muted">{item.preview}</pre>
      <span className="absolute top-2 right-2 rounded-md bg-background/80 px-1.5 py-0.5 text-[10px] font-semibold text-muted uppercase backdrop-blur">
        {item.category === "Web pages" ? "html" : item.lang || (CODE_CATEGORIES.has(item.category) ? "code" : item.kind)}
      </span>
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-composer to-transparent" />
    </div>
  );
}
