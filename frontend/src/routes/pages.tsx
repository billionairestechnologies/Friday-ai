import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Check, ChevronDown, Cloud, CloudOff, Copy, Download, FileText, History, Link2, Loader2, MessageSquare, Plus, Presentation, Sheet, Sparkles, Trash2, X } from "lucide-react";
import { ApiError } from "@/lib/api";
import { DocEditor } from "@/components/pages/doc-editor";
import { SheetEditor } from "@/components/pages/sheet-editor";
import { SlidesEditor } from "@/components/pages/slides-editor";
import { EXPORT_FORMATS, KIND_LABEL, exportPage, pagesApi, shareUrl, type DocContent, type Page, type PageContent, type PageKind, type PageSummary, type PageVersion, type SheetContent, type SlidesContent } from "@/lib/pages/api";
import { useDismiss } from "@/lib/use-dismiss";
import { cn } from "@/lib/utils";

/**
 * Pages — Friday's answer to Claude's in-place docs, sheets and slides. Friday creates them in chat
 * (create_page) and edits them (update_page); the user edits the same page here, every save is a
 * version, a page can be shared as a read-only link and exported to Word/PDF/Excel/PowerPoint.
 *
 * Saving: edits save ~1 s after typing stops, carrying the version they were based on; the server
 * refuses a save on top of a newer version (Friday edited meanwhile, or another tab) and the user
 * picks which copy wins instead of silently losing either. While there are no unsaved edits the
 * page polls, so Friday's edits from the chat show up live.
 */

export const KIND_ICON: Record<PageKind, typeof FileText> = { doc: FileText, sheet: Sheet, slides: Presentation };
export const KIND_COLOR: Record<PageKind, string> = { doc: "#185ABD", sheet: "#107C41", slides: "#D24726" };

const SAVE_DELAY_MS = 900;
const POLL_MS = 4000;

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function KindBadge({ kind, className }: { kind: PageKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-xl", className ?? "size-10")} style={{ background: `${KIND_COLOR[kind]}1f`, color: KIND_COLOR[kind] }}>
      <Icon className="size-5" strokeWidth={1.75} />
    </span>
  );
}

/* ───────────────────────────── List ───────────────────────────── */

export function PagesListPage() {
  const navigate = useNavigate();
  const [pages, setPages] = useState<PageSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<PageKind | null>(null);

  useEffect(() => {
    pagesApi
      .list()
      .then(setPages)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load your pages"));
  }, []);

  async function create(kind: PageKind) {
    setCreating(kind);
    try {
      const page = await pagesApi.create(kind, `Untitled ${KIND_LABEL[kind].toLowerCase()}`);
      void navigate({ to: "/pages/$pageId", params: { pageId: page.id } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the page");
      setCreating(null);
    }
  }

  async function remove(p: PageSummary) {
    if (!window.confirm(`Delete "${p.title}"? Shared links to it stop working.`)) return;
    try {
      await pagesApi.remove(p.id);
      setPages((list) => list?.filter((x) => x.id !== p.id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete");
    }
  }

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
      <div className="mx-auto max-w-5xl px-4 py-10 md:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">Pages</h1>
        <p className="mt-1 text-sm text-muted">Documents, spreadsheets and slides you and Friday edit together. Ask Friday in any chat to make one, or start one here.</p>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {(["doc", "sheet", "slides"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={creating !== null}
              onClick={() => void create(kind)}
              className="flex items-center gap-3 rounded-2xl border border-border bg-composer px-4 py-3.5 text-left transition-colors hover:bg-chip disabled:opacity-60"
            >
              <KindBadge kind={kind} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">New {KIND_LABEL[kind].toLowerCase()}</span>
                <span className="block text-xs text-muted">{kind === "doc" ? "Exports to Word, PDF" : kind === "sheet" ? "Formulas, exports to Excel" : "Exports to PowerPoint"}</span>
              </span>
              {creating === kind ? <Loader2 className="size-4 animate-spin text-muted" /> : <Plus className="size-4 text-muted" />}
            </button>
          ))}
        </div>

        {error && <p className="mt-4 text-sm text-danger">{error}</p>}

        <div className="mt-8">
          {pages === null && !error ? (
            <div className="flex justify-center py-16">
              <Loader2 className="size-5 animate-spin text-muted" />
            </div>
          ) : pages && pages.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border px-6 py-14 text-center">
              <Sparkles className="mx-auto size-6 text-muted" />
              <p className="mt-3 text-sm font-medium">No pages yet</p>
              <p className="mt-1 text-sm text-muted">Try asking Friday: “make a project plan doc” or “build a budget sheet for my trip”.</p>
            </div>
          ) : (
            <ul className="grid gap-2">
              {pages?.map((p) => (
                <li key={p.id} className="group flex items-center gap-3 rounded-2xl border border-border px-3.5 py-3 transition-colors hover:bg-chip">
                  <button type="button" onClick={() => void navigate({ to: "/pages/$pageId", params: { pageId: p.id } })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <KindBadge kind={p.kind} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{p.title}</span>
                      <span className="block truncate text-xs text-muted">
                        {KIND_LABEL[p.kind]} · edited {timeAgo(p.updated_at)}
                        {p.share_token ? " · shared" : ""}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${p.title}`}
                    onClick={() => void remove(p)}
                    className="flex size-8 items-center justify-center rounded-lg text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger focus:opacity-100"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── Editor ───────────────────────────── */

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

export function PageEditorPage({ pageId }: { pageId: string }) {
  const navigate = useNavigate();
  const [page, setPage] = useState<Page | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState<PageContent | null>(null);
  const [state, setState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"history" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Refs so timers and the poller always see the latest values.
  const pageRef = useRef<Page | null>(null);
  const draft = useRef<{ title: string; content: PageContent | null }>({ title: "", content: null });
  const edits = useRef(0); // bumps on every local edit; a save only clears "dirty" if nothing changed meanwhile
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef(false);
  const stateRef = useRef<SaveState>("saved");
  stateRef.current = state;

  const adopt = useCallback((p: Page) => {
    pageRef.current = p;
    draft.current = { title: p.title, content: p.content };
    setPage(p);
    setTitle(p.title);
    setContent(p.content);
  }, []);

  useEffect(() => {
    setPage(null);
    setLoadError(null);
    pagesApi
      .get(pageId)
      .then(adopt)
      .catch((e) => setLoadError(e instanceof ApiError && e.status === 404 ? "This page doesn't exist or was deleted." : e instanceof Error ? e.message : "Couldn't open the page"));
  }, [pageId, adopt]);

  const save = useCallback(async () => {
    const base = pageRef.current;
    if (!base || inFlight.current || stateRef.current === "conflict") return;
    inFlight.current = true;
    const sentAt = edits.current;
    setState("saving");
    try {
      const saved = await pagesApi.save(base.id, { title: draft.current.title.trim() || "Untitled", content: draft.current.content ?? undefined, baseVersion: base.version });
      pageRef.current = saved;
      setPage(saved);
      setSaveError(null);
      if (edits.current === sentAt) setState("saved");
      else {
        setState("dirty");
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setState("conflict");
      else {
        setState("error");
        setSaveError(e instanceof Error ? e.message : "Couldn't save");
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  const edit = useCallback(
    (next: { title?: string; content?: PageContent }) => {
      if (next.title !== undefined) {
        draft.current.title = next.title;
        setTitle(next.title);
      }
      if (next.content !== undefined) {
        draft.current.content = next.content;
        setContent(next.content);
      }
      edits.current += 1;
      if (stateRef.current === "conflict") return;
      setState("dirty");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS);
    },
    [save],
  );

  // Live updates: pick up Friday's (or another tab's) edits while the user has nothing unsaved.
  useEffect(() => {
    const id = window.setInterval(async () => {
      const current = pageRef.current;
      if (!current || document.hidden || stateRef.current !== "saved" || inFlight.current) return;
      try {
        const latest = await pagesApi.get(current.id);
        if (latest.version > (pageRef.current?.version ?? 0) && stateRef.current === "saved") {
          adopt(latest);
          setNotice("Updated with the latest changes");
          window.setTimeout(() => setNotice(null), 3000);
        }
      } catch {
        /* offline for a moment — the next tick retries */
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [adopt]);

  // Flush on leave; warn if a save is still pending.
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (stateRef.current === "dirty" || stateRef.current === "saving" || stateRef.current === "conflict") e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.clearTimeout(timer.current);
      if (stateRef.current === "dirty") void save();
    };
  }, [save]);

  async function resolveConflict(keep: "mine" | "theirs") {
    const latest = await pagesApi.get(pageId).catch(() => null);
    if (!latest) return;
    if (keep === "theirs") {
      adopt(latest);
      setState("saved");
      return;
    }
    pageRef.current = latest;
    setPage(latest);
    stateRef.current = "dirty";
    setState("dirty");
    await save();
  }

  if (loadError) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-6 text-center text-foreground">
        <div>
          <p className="text-sm text-muted">{loadError}</p>
          <button type="button" onClick={() => void navigate({ to: "/pages" })} className="mt-4 h-10 rounded-full border border-border px-4 text-sm">
            All pages
          </button>
        </div>
      </main>
    );
  }
  if (!page || !content) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted" />
      </main>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-2 md:px-3">
        <button type="button" aria-label="All pages" onClick={() => void navigate({ to: "/pages" })} className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-chip hover:text-foreground">
          <ArrowLeft className="size-4" />
        </button>
        <KindBadge kind={page.kind} className="size-8" />
        <input
          aria-label="Title"
          value={title}
          onChange={(e) => edit({ title: e.target.value.slice(0, 200) })}
          className="h-9 min-w-0 flex-1 rounded-lg bg-transparent px-2 text-[15px] font-medium outline-none hover:bg-chip focus:bg-chip"
        />
        <SaveIndicator state={state} error={saveError} onRetry={() => void save()} />
        {page.conversation_id && (
          <button
            type="button"
            title="Open the chat that made this page"
            onClick={() => void navigate({ to: "/c/$conversationId", params: { conversationId: page.conversation_id! } })}
            className="hidden h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted hover:bg-chip hover:text-foreground sm:flex"
          >
            <MessageSquare className="size-4" /> Chat
          </button>
        )}
        <button
          type="button"
          aria-label="Version history"
          title="Version history"
          onClick={() => setPanel((p) => (p === "history" ? null : "history"))}
          className={cn("flex size-9 items-center justify-center rounded-lg text-muted hover:bg-chip hover:text-foreground", panel === "history" && "bg-chip-on text-foreground")}
        >
          <History className="size-4" />
        </button>
        <ExportMenu page={page} title={title} beforeExport={async () => (stateRef.current === "dirty" ? save() : undefined)} />
        <ShareMenu page={page} onChange={(p) => adopt({ ...p, content: draft.current.content ?? p.content, title: draft.current.title })} />
      </header>

      {state === "conflict" && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-[#f59e0b1a] px-4 py-2 text-sm">
          <span className="flex-1">This page changed somewhere else (Friday or another tab) while you were editing.</span>
          <button type="button" onClick={() => void resolveConflict("theirs")} className="h-8 rounded-full border border-border px-3">
            Load latest
          </button>
          <button type="button" onClick={() => void resolveConflict("mine")} className="h-8 rounded-full bg-foreground px-3 text-background">
            Keep my version
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {page.kind === "doc" && <DocEditor markdown={(content as DocContent).markdown} onChange={(markdown) => edit({ content: { markdown } })} />}
          {page.kind === "sheet" && <SheetEditor content={content as SheetContent} onChange={(c) => edit({ content: c })} />}
          {page.kind === "slides" && <SlidesEditor content={content as SlidesContent} onChange={(c) => edit({ content: c })} />}
        </div>
        <AnimatePresence>
          {panel === "history" && (
            <HistoryPanel
              page={page}
              onClose={() => setPanel(null)}
              onRestored={(p) => {
                adopt(p);
                setState("saved");
              }}
            />
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {notice && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-sm text-background shadow-lg">
            {notice}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SaveIndicator({ state, error, onRetry }: { state: SaveState; error: string | null; onRetry: () => void }) {
  if (state === "error")
    return (
      <button type="button" onClick={onRetry} title={error ?? undefined} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-danger hover:bg-chip">
        <CloudOff className="size-3.5" /> Not saved · retry
      </button>
    );
  const label = state === "saving" ? "Saving…" : state === "dirty" ? "Editing" : state === "conflict" ? "Not saved" : "Saved";
  return (
    <span className="hidden h-8 shrink-0 items-center gap-1.5 px-2 text-xs text-muted sm:flex" aria-live="polite">
      {state === "saving" ? <Loader2 className="size-3.5 animate-spin" /> : <Cloud className="size-3.5" />}
      {label}
    </span>
  );
}

function ExportMenu({ page, title, beforeExport }: { page: Page; title: string; beforeExport: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label="Download" title="Download" className="flex h-9 items-center gap-1 rounded-lg px-2.5 text-sm text-muted hover:bg-chip hover:text-foreground">
        <Download className="size-4" />
        <ChevronDown className="size-3" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-56 rounded-xl border border-border bg-composer p-1 shadow-xl">
          {EXPORT_FORMATS[page.kind].map((f) => (
            <button
              key={f.format}
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                setBusy(f.format);
                setError(null);
                try {
                  await beforeExport();
                  await exportPage(page.id, f.format, title);
                  setOpen(false);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Export failed");
                } finally {
                  setBusy(null);
                }
              }}
              className="flex h-9 w-full items-center justify-between rounded-lg px-3 text-left text-sm hover:bg-chip"
            >
              {f.label}
              {busy === f.format && <Loader2 className="size-3.5 animate-spin" />}
            </button>
          ))}
          {error && <p className="px-3 py-1 text-xs text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}

function ShareMenu({ page, onChange }: { page: Page; onChange: (p: Page) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  const link = page.share_token ? shareUrl(page.share_token) : null;

  async function toggle(on: boolean) {
    setBusy(true);
    setError(null);
    try {
      onChange(await pagesApi.share(page.id, on));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change sharing");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className={cn("flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium", link ? "border border-border text-foreground" : "bg-foreground text-background")}>
        <Link2 className="size-4" /> {link ? "Shared" : "Share"}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-80 rounded-2xl border border-border bg-composer p-4 shadow-xl">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Anyone with the link can view</p>
              <p className="mt-0.5 text-xs text-muted">Read-only. They see your latest saved version; turn it off any time.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(link)}
              aria-label="Share by link"
              disabled={busy}
              onClick={() => void toggle(!link)}
              className={cn("relative h-6 w-10 shrink-0 rounded-full transition-colors", link ? "bg-[#2563eb]" : "bg-chip-on")}
            >
              <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", link ? "left-[18px]" : "left-0.5")} />
            </button>
          </div>
          {link && (
            <div className="mt-3 flex items-center gap-2">
              <input readOnly value={link} onFocus={(e) => e.target.select()} className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 text-xs text-muted" />
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(link);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
                className="flex h-9 items-center gap-1 rounded-lg border border-border px-2.5 text-xs"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}

function HistoryPanel({ page, onClose, onRestored }: { page: Page; onClose: () => void; onRestored: (p: Page) => void }) {
  const [versions, setVersions] = useState<PageVersion[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    pagesApi
      .versions(page.id)
      .then(setVersions)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load history"));
  }, [page.id, page.version]);

  return (
    <motion.aside
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 300, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="absolute inset-y-0 right-0 z-30 flex shrink-0 flex-col overflow-hidden border-l border-border bg-background md:relative"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-medium">Version history</span>
        <button type="button" aria-label="Close history" onClick={onClose} className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-chip">
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error && <p className="p-2 text-xs text-danger">{error}</p>}
        {!versions && !error && <Loader2 className="mx-auto mt-6 size-4 animate-spin text-muted" />}
        {versions?.map((v) => {
          const current = v.version === page.version;
          return (
            <div key={v.version} className="flex items-center gap-2 rounded-xl px-2.5 py-2 hover:bg-chip">
              <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold", v.author === "friday" ? "bg-[#4f46e51f] text-[#4F46E5]" : "bg-chip-on text-muted")}>
                {v.author === "friday" ? <Sparkles className="size-3.5" /> : "You"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">
                  v{v.version} · {v.author === "friday" ? "Friday" : "You"}
                </div>
                <div className="truncate text-xs text-muted">{timeAgo(v.created_at)}</div>
              </div>
              {current ? (
                <span className="text-xs text-subtle">Current</span>
              ) : (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(v.version);
                    try {
                      onRestored(await pagesApi.restore(page.id, v.version));
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "Couldn't restore");
                    } finally {
                      setBusy(null);
                    }
                  }}
                  className="h-7 rounded-full border border-border px-2.5 text-xs hover:bg-background"
                >
                  {busy === v.version ? <Loader2 className="size-3 animate-spin" /> : "Restore"}
                </button>
              )}
            </div>
          );
        })}
        <p className="px-2.5 py-3 text-xs text-subtle">Restoring makes a new version — nothing is lost.</p>
      </div>
    </motion.aside>
  );
}

/* ───────────────────────────── Public view ───────────────────────────── */

export function SharedPageView({ token }: { token: string }) {
  const [page, setPage] = useState<Pick<Page, "kind" | "title" | "content" | "updated_at"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    pagesApi
      .shared(token)
      .then((p) => {
        setPage(p);
        document.title = `${p.title} · Friday`;
      })
      .catch((e) => setError(e instanceof Error ? e.message : "This link doesn't work"));
  }, [token]);

  if (error) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-6 text-center text-foreground">
        <div>
          <p className="text-sm text-muted">{error}</p>
          <a href="/" className="mt-4 inline-flex h-10 items-center rounded-full border border-border px-4 text-sm">
            Go to Friday
          </a>
        </div>
      </main>
    );
  }
  if (!page) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted" />
      </main>
    );
  }
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <KindBadge kind={page.kind} className="size-8" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-medium">{page.title}</h1>
          <p className="truncate text-xs text-muted">
            {KIND_LABEL[page.kind]} · updated {timeAgo(page.updated_at)} · view only
          </p>
        </div>
        <a href="/" className="hidden h-9 items-center rounded-full border border-border px-3.5 text-sm sm:inline-flex">
          Made with Friday
        </a>
      </header>
      {page.kind === "doc" && <DocEditor markdown={(page.content as DocContent).markdown} readOnly />}
      {page.kind === "sheet" && <SheetEditor content={page.content as SheetContent} readOnly />}
      {page.kind === "slides" && <SlidesEditor content={page.content as SlidesContent} readOnly />}
    </div>
  );
}
