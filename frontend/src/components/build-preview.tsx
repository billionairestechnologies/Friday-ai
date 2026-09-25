import { useCallback, useEffect, useMemo, useState, type PointerEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileCode2,
  Folder,
  FolderOpen,
  Globe,
  ListTree,
  Loader2,
  PanelRightClose,
  RefreshCw,
  Smartphone,
  SquareStack,
} from "lucide-react";
import { API_BASE_URL, api, getAccessToken } from "@/lib/api";
import { cn } from "@/lib/utils";

type ProjectFiles = Record<string, string>;

export async function downloadProjectZip(conversationId: string) {
  const token = getAccessToken();
  const res = await fetch(`${API_BASE_URL}/build/${conversationId}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const disposition = res.headers.get("content-disposition") ?? "";
  const name = disposition.match(/filename="([^"]+)"/)?.[1] ?? "project.zip";
  const blobUrl = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = name;
  a.click();
  URL.revokeObjectURL(blobUrl);
}

type TreeNode = { name: string; path: string; children: TreeNode[]; file: boolean };

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [], file: false };
  for (const path of paths) {
    let node = root;
    const parts = path.split("/");
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const childPath = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part && c.file === isFile);
      if (!child) {
        child = { name: part, path: childPath, children: [], file: isFile };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.file === b.file ? a.name.localeCompare(b.name) : a.file ? 1 : -1));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const pad = { paddingLeft: 8 + depth * 14 };
  if (node.file) {
    return (
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        style={pad}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-sm",
          selected === node.path ? "bg-chip text-foreground" : "text-muted hover:text-foreground",
        )}
      >
        <FileCode2 className="size-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
    );
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={pad}
        className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-sm text-foreground hover:bg-chip/60"
      >
        {open ? <ChevronDown className="size-3 shrink-0 text-muted" /> : <ChevronRight className="size-3 shrink-0 text-muted" />}
        {open ? <FolderOpen className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />}
        <span className="truncate">{node.name}</span>
      </button>
      {open && node.children.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />)}
    </div>
  );
}

const iconBtn =
  "premium-control flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground disabled:opacity-40";

/** Canvas view for a Build Mode project, laid out like the reference product: globe/files icon tabs
 *  on the left, then a browser-style toolbar over the running app, or a file tree + code viewer.
 *  The sandbox is short-lived, so unless the URL just came from the live turn the backend is asked
 *  to make sure it's alive (it restores the snapshot and restarts the server if it expired). */
export function BuildCanvas({
  conversationId,
  liveUrl,
  onClose,
  onResizeStart,
}: {
  conversationId: string;
  liveUrl?: string;
  onClose: () => void;
  onResizeStart: (e: PointerEvent<HTMLButtonElement>) => void;
}) {
  const [url, setUrl] = useState<string | null>(liveUrl ?? null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(liveUrl ? "ready" : "loading");
  const [message, setMessage] = useState<string | null>(null);
  const [view, setView] = useState<"preview" | "files">("preview");
  const [files, setFiles] = useState<ProjectFiles | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showTree, setShowTree] = useState(true);
  const [mobile, setMobile] = useState(false);
  const [nonce, setNonce] = useState(0);

  const ensure = useCallback(() => {
    setStatus("loading");
    setMessage(null);
    api
      .post<{ url: string | null; message?: string }>(`/build/${conversationId}/preview`, {})
      .then((res) => {
        if (res.url) {
          setUrl(res.url);
          setStatus("ready");
        } else {
          setStatus("error");
          setMessage(res.message ?? "The preview couldn't be started.");
        }
      })
      .catch((err) => {
        setStatus("error");
        setMessage(err instanceof Error ? err.message : "The preview couldn't be started.");
      });
  }, [conversationId]);

  // Once a URL is showing (from the live turn), don't re-run the restore round-trip when the live
  // snapshot clears at the end of the turn — that would reload the iframe for no reason.
  const hasUrl = url !== null;
  useEffect(() => {
    if (liveUrl) {
      setUrl(liveUrl);
      setStatus("ready");
    } else if (!hasUrl) {
      ensure();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, liveUrl, ensure]);

  useEffect(() => {
    if (view !== "files" || files) return;
    api
      .get<{ files: ProjectFiles }>(`/build/${conversationId}/files`)
      .then((res) => {
        setFiles(res.files);
        const first = Object.keys(res.files).find((p) => /(^|\/)(App|main|index)\.(jsx|tsx|js|ts|html|py)$/.test(p)) ?? Object.keys(res.files).sort()[0];
        setSelected(first ?? null);
      })
      .catch((err) => setMessage(err instanceof Error ? err.message : "Couldn't load the files"));
  }, [view, files, conversationId]);

  const tree = useMemo(() => buildTree(Object.keys(files ?? {})), [files]);
  const lines = useMemo(() => (selected && files ? files[selected]!.split("\n") : []), [selected, files]);

  return (
    <aside className="premium-panel relative flex h-full w-full min-w-0 flex-col border-l border-border max-md:fixed max-md:inset-0 max-md:z-40">
      <button
        type="button"
        aria-label="Resize canvas"
        onPointerDown={onResizeStart}
        className="group premium-control absolute top-0 bottom-0 left-0 z-10 hidden w-2 -translate-x-1 cursor-col-resize md:flex md:items-center md:justify-center"
      >
        <span className="h-10 w-[3px] rounded-full bg-border transition-colors group-hover:bg-muted" />
      </button>

      {/* Icon tabs: globe = running preview, stack = project files. */}
      <div className="flex h-12 shrink-0 items-center gap-1 px-3">
        {(
          [
            ["preview", Globe, "Preview"],
            ["files", SquareStack, "Files"],
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            type="button"
            aria-label={label}
            aria-pressed={view === id}
            onClick={() => setView(id)}
            className={cn(
              "premium-control flex size-8 items-center justify-center rounded-lg",
              view === id ? "bg-chip text-foreground" : "text-muted hover:text-foreground",
            )}
          >
            <Icon className="size-[18px]" />
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" aria-label="Close canvas" onClick={onClose} className={iconBtn}>
          <PanelRightClose className="size-4" />
        </button>
      </div>

      {view === "preview" ? (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/80 px-3">
          <button type="button" aria-label="Reload" onClick={() => (url ? setNonce((n) => n + 1) : ensure())} className={iconBtn}>
            <RefreshCw className="size-3.5" />
          </button>
          <span className="min-w-0 flex-1 truncate px-1 text-xs text-subtle">{url ? url.replace(/^https:\/\//, "") : ""}</span>
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open in new tab" className={iconBtn}>
              <ExternalLink className="size-3.5" />
            </a>
          )}
          <button type="button" aria-label="Toggle mobile view" aria-pressed={mobile} onClick={() => setMobile((v) => !v)} className={cn(iconBtn, mobile && "bg-chip text-foreground")}>
            <Smartphone className="size-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/80 px-3">
          <button type="button" aria-label="Toggle file list" aria-pressed={showTree} onClick={() => setShowTree((v) => !v)} className={cn(iconBtn, showTree && "bg-chip text-foreground")}>
            <ListTree className="size-3.5" />
          </button>
          <span className="min-w-0 flex-1 truncate px-1 text-sm text-foreground">{selected ?? ""}</span>
          <button type="button" aria-label="Download project" onClick={() => void downloadProjectZip(conversationId).catch((e) => setMessage(e instanceof Error ? e.message : "Download failed"))} className={iconBtn}>
            <Download className="size-3.5" />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {view === "preview" ? (
          status === "ready" && url ? (
            <div className={cn("flex h-full w-full justify-center", mobile && "bg-chip/40")}>
              <iframe
                key={`${url}-${nonce}`}
                title="Project preview"
                src={url}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                className={cn("h-full border-0 bg-white", mobile ? "w-[390px] max-w-full border-x border-border" : "w-full")}
              />
            </div>
          ) : status === "loading" ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted">
              <Loader2 className="size-5 animate-spin" />
              Starting your project… restoring files and dependencies can take a minute.
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-danger">
              <pre className="max-h-60 max-w-full overflow-auto text-left text-xs whitespace-pre-wrap">{message}</pre>
              <button type="button" onClick={ensure} className="rounded-full bg-chip px-3 py-1.5 text-xs text-foreground">
                Try again
              </button>
            </div>
          )
        ) : files === null ? (
          <div className="flex h-full items-center justify-center text-muted">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="flex h-full min-h-0">
            {showTree && (
              <div className="w-56 shrink-0 overflow-auto border-r border-border/80 p-2 max-md:w-40">
                <div className="px-2 pb-1 text-xs text-subtle">Files</div>
                {tree.map((n) => (
                  <TreeRow key={n.path} node={n} depth={0} selected={selected} onSelect={setSelected} />
                ))}
              </div>
            )}
            <div className="min-w-0 flex-1 overflow-auto bg-composer/40 py-2 font-mono text-xs leading-relaxed">
              {lines.map((line, i) => (
                <div key={i} className="flex">
                  <span className="w-10 shrink-0 pr-3 text-right text-subtle select-none">{i + 1}</span>
                  <span className="pr-4 whitespace-pre">{line || " "}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
