import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Download, LibraryBig, Search, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type LibraryItem = {
  id: string;
  conversation_id: string | null;
  title: string;
  kind: "html" | "react" | "code" | "data" | "image";
  lang: string | null;
  category: string;
  created_at: string;
  preview: string;
  content?: string;
};

const EXTENSIONS: Record<string, string> = {
  html: "html", python: "py", py: "py", javascript: "js", js: "js", typescript: "ts", ts: "ts",
  jsx: "jsx", tsx: "tsx", css: "css", scss: "scss", bash: "sh", sh: "sh", shell: "sh", sql: "sql",
  json: "json", yaml: "yml", yml: "yml", xml: "xml", csv: "csv", java: "java", r: "r", go: "go",
  rust: "rs", c: "c", cpp: "cpp", php: "php", ruby: "rb", swift: "swift", kotlin: "kt",
};

function fileNameFor(item: LibraryItem) {
  const base = item.title.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) || "friday";
  if (item.kind === "image") return `${base}.png`;
  const ext = EXTENSIONS[(item.lang ?? "").toLowerCase()] ?? (item.kind === "react" ? "jsx" : "txt");
  return `${base}.${ext}`;
}

async function download(item: LibraryItem, content: string) {
  let blob: Blob;
  if (item.kind === "image") {
    blob = await (await fetch(content)).blob();
  } else {
    blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileNameFor(item);
  a.click();
  URL.revokeObjectURL(url);
}

export function LibraryPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("All");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<LibraryItem | null>(null);
  const [copied, setCopied] = useState(false);

  function load() {
    api
      .get<{ items: LibraryItem[] }>("/library")
      .then((res) => {
        setItems(res.items);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load your library"));
  }
  useEffect(load, []);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items ?? []) map.set(item.category, (map.get(item.category) ?? 0) + 1);
    return map;
  }, [items]);

  const visible = (items ?? []).filter(
    (item) =>
      (category === "All" || item.category === category) &&
      (!query.trim() || `${item.title} ${item.lang ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())),
  );

  async function openItem(item: LibraryItem) {
    setCopied(false);
    setOpen(item);
    if (item.kind === "image") return;
    try {
      const res = await api.get<{ item: LibraryItem }>(`/library/${item.id}`);
      setOpen(res.item);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open that item");
      setOpen(null);
    }
  }

  async function remove(item: LibraryItem) {
    if (!window.confirm(`Delete "${item.title}" from your library?`)) return;
    try {
      await api.delete(`/library/${item.id}`);
      setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? prev);
      setOpen(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that item");
    }
  }

  const body = open ? (open.kind === "image" ? open.preview : (open.content ?? open.preview)) : "";

  return (
    <div className="min-h-dvh bg-background px-4 py-8 text-foreground md:px-8">
      <button
        type="button"
        onClick={() => void navigate({ to: "/" })}
        aria-label="Close"
        className="fixed top-4 right-4 z-10 flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-chip hover:text-foreground"
      >
        <X className="size-5" />
      </button>

      <div className="mx-auto max-w-5xl">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-chip">
            <LibraryBig className="size-5 text-muted" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Library</h1>
            <p className="text-sm text-muted">Everything Friday has written for you, saved automatically.</p>
          </div>
        </div>

        <div className="mt-6 flex items-center gap-2 rounded-xl border border-border bg-composer px-3">
          <Search className="size-4 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your library"
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-subtle"
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {["All", ...counts.keys()].map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setCategory(name)}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm transition-colors",
                category === name ? "bg-foreground text-background" : "bg-chip text-muted hover:text-foreground",
              )}
            >
              {name}
              <span className="ml-1.5 opacity-60">{name === "All" ? (items?.length ?? 0) : counts.get(name)}</span>
            </button>
          ))}
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
        )}

        {items === null && !error && <p className="mt-10 text-center text-sm text-muted">Loading…</p>}
        {items && visible.length === 0 && (
          <p className="mt-10 text-center text-sm text-muted">
            {items.length === 0
              ? "Nothing here yet. Code, pages and images from your chats are saved here automatically."
              : "No matches."}
          </p>
        )}

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => void openItem(item)}
              className="flex flex-col gap-2 rounded-2xl border border-border bg-composer p-3 text-left transition-colors hover:border-foreground/30"
            >
              <div className="flex items-center justify-between gap-2 text-xs text-muted">
                <span>{item.category}</span>
                <span>{new Date(item.created_at).toLocaleDateString()}</span>
              </div>
              <div className="truncate text-sm font-medium">{item.title}</div>
              {item.kind === "image" ? (
                <img src={item.preview} alt={item.title} className="h-32 w-full rounded-lg object-cover" loading="lazy" />
              ) : (
                <pre className="h-32 overflow-hidden rounded-lg bg-chip p-2 text-xs text-muted">{item.preview}</pre>
              )}
            </button>
          ))}
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-4" onClick={() => setOpen(null)}>
          <div
            className="flex max-h-[85dvh] w-full max-w-3xl flex-col rounded-2xl border border-border bg-background p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{open.title}</div>
                <div className="text-xs text-muted">{open.category}</div>
              </div>
              {open.kind !== "image" && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(body).then(() => setCopied(true));
                  }}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-chip hover:text-foreground"
                >
                  <Copy className="size-4" /> {copied ? "Copied" : "Copy"}
                </button>
              )}
              <button
                type="button"
                onClick={() => void download(open, body).catch(() => setError("Couldn't download that file"))}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-chip hover:text-foreground"
              >
                <Download className="size-4" /> Download
              </button>
              <button
                type="button"
                onClick={() => void remove(open)}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-danger hover:bg-danger/10"
              >
                <Trash2 className="size-4" /> Delete
              </button>
            </div>
            <div className="mt-3 min-h-0 flex-1 overflow-auto">
              {open.kind === "image" ? (
                <img src={body} alt={open.title} className="mx-auto max-h-[60dvh] rounded-lg" />
              ) : open.kind === "html" ? (
                <iframe title={open.title} sandbox="allow-scripts" srcDoc={body} className="h-[50dvh] w-full rounded-lg bg-white" />
              ) : (
                <pre className="overflow-auto rounded-lg bg-chip p-3 text-xs">{body}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
