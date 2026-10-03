import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileCode2,
  FileDiff,
  Folder,
  KeyRound,
  Rocket,
  Trash2,
  FolderOpen,
  Globe,
  ListTree,
  Loader2,
  PanelRightClose,
  RefreshCw,
  Smartphone,
  SquareStack,
  TerminalSquare,
} from "lucide-react";
import { API_BASE_URL, api, getAccessToken } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { BuildStep } from "@/lib/chat/types";

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

/** Everything the build ran, as one continuous terminal session (like Claude Code's): each command
 *  with its output and how it ended, file writes as dim comment lines between them, the running
 *  command live at the bottom. Follows new output unless the user scrolled up to read. */
function SessionTerminal({ steps, building }: { steps: BuildStep[]; building: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const entries = steps.filter((st) => (st.cmd && (st.kind === "run" || st.kind === "start")) || (st.kind === "write" && st.state !== "running" && st.path));
  const signature = entries.map((st) => `${st.id}:${st.state}:${st.output?.length ?? 0}`).join("|");
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [signature]);
  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-[#0c0c0d] px-6 text-center font-mono text-xs text-[#6b7078]">
        <TerminalSquare className="size-5" />
        {building ? "Waiting for the first command…" : "Commands Friday runs for this project show up here."}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="scroll-on-dark h-full overflow-auto bg-[#0c0c0d] px-4 py-3 font-mono text-[12px] leading-[1.6] text-[#c9ccd1]"
    >
      {entries.map((st) =>
        st.kind === "write" ? (
          <div key={st.id} className="text-[#5c6370]">
            # {st.lang === "diff" ? "edited" : "wrote"} {st.path}
            {st.added ? <span className="text-emerald-500/70"> +{st.added}</span> : null}
            {st.removed ? <span className="text-red-400/70"> −{st.removed}</span> : null}
          </div>
        ) : (
          <div key={st.id} className="step-enter mt-2 first:mt-0">
            <div className="whitespace-pre-wrap">
              <span className={st.state === "error" ? "text-red-400" : "text-emerald-400"}>$ </span>
              <span className="text-[#e8eaed]">{st.cmd}</span>
            </div>
            {(st.output ?? (st.state !== "running" ? st.detail : "")) && (
              <div className="whitespace-pre-wrap text-[#aeb3ba]">{(st.output ?? st.detail ?? "").replace(/\s+$/, "")}</div>
            )}
            {st.state === "running" ? (
              <span className="terminal-cursor" aria-hidden />
            ) : (
              <div className={cn("text-[11px]", st.state === "error" ? "text-red-400/90" : "text-[#5c6370]")}>
                {st.kind === "start" ? (st.state === "ok" ? "✓ server running" : "✗ server failed to start") : `exit ${st.exitCode ?? (st.state === "ok" ? 0 : 1)}`}
                {st.ms != null ? ` · ${st.ms < 1000 ? `${st.ms}ms` : `${(st.ms / 1000).toFixed(1)}s`}` : ""}
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}

type FileChange = { path: string; code: string; added: number; removed: number; isNew: boolean; count: number };

/** Every file the agent wrote or edited in this session, newest change per file first. The steps
 *  already carry the change itself (a code preview for a new file, +/- lines for an edit), so this
 *  needs no extra round trip. */
function collectChanges(steps: BuildStep[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const st of steps) {
    if (st.kind !== "write" || st.state !== "ok" || !st.path) continue;
    const prev = byPath.get(st.path);
    const isNew = /^Wrote /.test(st.label) && !prev;
    byPath.delete(st.path);
    byPath.set(st.path, {
      path: st.path,
      code: st.code ?? "",
      added: (prev?.added ?? 0) + (st.added ?? 0),
      removed: (prev?.removed ?? 0) + (st.removed ?? 0),
      isNew: prev ? prev.isNew : isNew,
      count: (prev?.count ?? 0) + 1,
    });
  }
  return [...byPath.values()].reverse();
}

function DiffView({ steps }: { steps: BuildStep[] }) {
  const changes = useMemo(() => collectChanges(steps), [steps]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (changes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted">
        <FileDiff className="size-5" />
        No changes yet — files Friday writes or edits show up here.
      </div>
    );
  }
  const totalAdded = changes.reduce((n, c) => n + c.added, 0);
  const totalRemoved = changes.reduce((n, c) => n + c.removed, 0);
  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center gap-2 border-b border-border/80 px-4 py-2 text-xs text-muted">
        {changes.length} file{changes.length === 1 ? "" : "s"} changed
        <span className="text-emerald-600 dark:text-emerald-400">+{totalAdded}</span>
        <span className="text-danger">−{totalRemoved}</span>
      </div>
      {changes.map((c) => {
        const expanded = open[c.path] ?? changes.length <= 3;
        return (
          <div key={c.path} className="border-b border-border/60">
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [c.path]: !expanded }))}
              className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-chip/60"
            >
              <ChevronRight className={cn("size-3.5 shrink-0 text-subtle transition-transform", expanded && "rotate-90")} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{c.path}</span>
              {c.isNew && <span className="rounded-full bg-chip px-1.5 py-0.5 text-[10px] text-muted">new</span>}
              <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400">+{c.added}</span>
              <span className="font-mono text-[11px] text-danger">−{c.removed}</span>
            </button>
            {expanded && c.code && (
              <pre className="overflow-x-auto bg-composer/40 py-1.5 font-mono text-xs leading-relaxed">
                {c.code.split("\n").map((line, i) => {
                  const kind = c.isNew ? "+" : line.startsWith("+ ") ? "+" : line.startsWith("- ") ? "-" : " ";
                  const text = !c.isNew && (kind === "+" || kind === "-") ? line.slice(2) : line;
                  return (
                    <div
                      key={i}
                      className={cn(
                        "flex px-4",
                        kind === "+" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                        kind === "-" && "bg-danger/10 text-danger",
                      )}
                    >
                      <span className="w-4 shrink-0 select-none opacity-60">{kind === " " ? "" : kind}</span>
                      <span className="whitespace-pre">{text || " "}</span>
                    </div>
                  );
                })}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Project secrets (names only — values are write-only): injected as env vars into the sandbox and
 *  redacted from anything the model or the user sees. */
function SecretsView({ conversationId }: { conversationId?: string }) {
  const [list, setList] = useState<{ name: string; updatedAt: string }[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!conversationId) return;
    api
      .get<{ secrets: { name: string; updatedAt: string }[] }>(`/build/${conversationId}/secrets`)
      .then((r) => setList(r.secrets))
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load secrets"));
  }, [conversationId]);
  useEffect(load, [load]);

  if (!conversationId) return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">Start the build first, then add its secrets here.</div>;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/build/${conversationId}/secrets`, { name: name.trim(), value });
      setName("");
      setValue("");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the secret");
    } finally {
      setBusy(false);
    }
  }
  async function remove(n: string) {
    setError(null);
    try {
      await api.delete(`/build/${conversationId}/secrets/${encodeURIComponent(n)}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete the secret");
    }
  }

  return (
    <div className="h-full overflow-auto p-4">
      <p className="text-xs leading-relaxed text-muted">
        API keys and other private values for this project. They're available to the app as environment variables (e.g. <code className="font-mono">process.env.STRIPE_KEY</code>), are also set on Vercel when you deploy, and are never shown to the AI or printed in the terminal.
      </p>
      <div className="mt-3 flex flex-col gap-2 rounded-xl border border-border bg-composer p-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
          placeholder="NAME (e.g. OPENAI_API_KEY)"
          className="h-9 rounded-lg border border-border bg-background px-2.5 font-mono text-xs text-foreground outline-none"
        />
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Value"
          autoComplete="off"
          className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none"
        />
        <button
          type="button"
          disabled={busy || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name.trim()) || !value}
          onClick={() => void save()}
          className="h-9 rounded-lg bg-foreground text-xs font-medium text-background disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save secret"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      <ul className="mt-3 flex flex-col gap-1">
        {list === null ? (
          <li className="text-xs text-subtle">Loading…</li>
        ) : list.length === 0 ? (
          <li className="text-xs text-subtle">No secrets yet.</li>
        ) : (
          list.map((sct) => (
            <li key={sct.name} className="flex items-center gap-2 rounded-lg bg-chip/50 px-3 py-2">
              <KeyRound className="size-3.5 text-subtle" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{sct.name}</span>
              <span className="text-[11px] text-subtle">••••••</span>
              <button type="button" aria-label={`Delete ${sct.name}`} onClick={() => void remove(sct.name)} className="rounded p-1 text-subtle hover:text-danger">
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/** One-click deploy to Vercel (the user's connected account). Shows the live URL or what went wrong. */
function DeployButton({ conversationId, disabled }: { conversationId?: string; disabled: boolean }) {
  const [state, setState] = useState<{ busy: boolean; url?: string; error?: string }>({ busy: false });
  if (!conversationId) return null;
  async function deploy() {
    setState({ busy: true });
    try {
      const res = await api.post<{ url: string }>(`/build/${conversationId}/deploy`, {});
      setState({ busy: false, url: res.url });
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : "Deploy failed" });
    }
  }
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => void deploy()}
        disabled={disabled || state.busy}
        title={disabled ? "Wait for the build to finish" : "Deploy to Vercel"}
        className="premium-control flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-2.5 text-xs font-medium text-background disabled:opacity-40"
      >
        {state.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}
        <span className="max-sm:hidden">{state.busy ? "Deploying…" : "Deploy"}</span>
      </button>
      {(state.url || state.error) && (
        <div className="absolute top-10 right-0 z-30 w-72 rounded-xl border border-border bg-elevated p-3 text-xs shadow-[var(--shadow-panel)]">
          {state.url ? (
            <>
              <p className="text-foreground">Live on Vercel 🎉</p>
              <a href={state.url} target="_blank" rel="noopener noreferrer" className="mt-1 block truncate text-sky-600 underline dark:text-sky-400">
                {state.url}
              </a>
            </>
          ) : (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-danger">{state.error}</pre>
          )}
          <button type="button" onClick={() => setState({ busy: false })} className="mt-2 text-muted hover:text-foreground">
            Close
          </button>
        </div>
      )}
    </div>
  );
}

/** The Build workspace panel: Preview (the running app in a browser frame), Files (tree + code) and
 *  Terminal (the whole session's commands and output). The sandbox is short-lived, so unless the
 *  URL just came from the live turn the backend is asked to make sure it's alive (it restores the
 *  snapshot and restarts the server if it expired) — only when the Preview tab is actually open. */
export function BuildCanvas({
  conversationId,
  liveUrl,
  hasPreview = true,
  steps = [],
  building = false,
  onClose,
  onResizeStart,
}: {
  conversationId?: string;
  liveUrl?: string;
  /** A preview has existed for this project (so restoring one is worth trying). */
  hasPreview?: boolean;
  /** Every build step in the chat — drives the Terminal tab and Files refreshes. */
  steps?: BuildStep[];
  building?: boolean;
  onClose: () => void;
  onResizeStart: (e: PointerEvent<HTMLButtonElement>) => void;
}) {
  const [url, setUrl] = useState<string | null>(liveUrl ?? null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(liveUrl ? "ready" : "idle");
  const [message, setMessage] = useState<string | null>(null);
  const [view, setView] = useState<"preview" | "files" | "diff" | "terminal" | "secrets">(liveUrl || hasPreview ? "preview" : "terminal");
  const [files, setFiles] = useState<ProjectFiles | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showTree, setShowTree] = useState(true);
  const [mobile, setMobile] = useState(false);
  const [nonce, setNonce] = useState(0);
  const commandRunning = steps.some((st) => st.state === "running" && (st.kind === "run" || st.kind === "start"));
  // Bumps whenever the agent finishes writing a file — the Files tab refetches to stay current.
  const filesVersion = steps.filter((st) => st.kind === "write" && st.state === "ok").length;
  const fetchedVersion = useRef(-1);

  const ensure = useCallback(() => {
    if (!conversationId) return;
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

  // A live preview URL arriving mid-build flips the panel to Preview so the user sees the app appear.
  const sawLiveUrl = useRef(Boolean(liveUrl));
  useEffect(() => {
    if (!liveUrl) return;
    setUrl(liveUrl);
    setStatus("ready");
    if (!sawLiveUrl.current) {
      sawLiveUrl.current = true;
      setView("preview");
    }
  }, [liveUrl]);

  // Once a URL is showing, don't re-run the restore round-trip when the live snapshot clears at the
  // end of the turn — that would reload the iframe for no reason.
  useEffect(() => {
    if (view !== "preview" || url || liveUrl || !hasPreview || status !== "idle") return;
    ensure();
  }, [view, url, liveUrl, hasPreview, status, ensure]);

  useEffect(() => {
    if (view !== "files" || !conversationId) return;
    if (files && fetchedVersion.current === filesVersion) return;
    fetchedVersion.current = filesVersion;
    api
      .get<{ files: ProjectFiles }>(`/build/${conversationId}/files`)
      .then((res) => {
        setFiles(res.files);
        setSelected((current) =>
          current && res.files[current] != null
            ? current
            : (Object.keys(res.files).find((p) => /(^|\/)(App|main|index)\.(jsx|tsx|js|ts|html|py)$/.test(p)) ?? Object.keys(res.files).sort()[0] ?? null),
        );
      })
      .catch((err) => setMessage(err instanceof Error ? err.message : "Couldn't load the files"));
  }, [view, files, filesVersion, conversationId]);

  const tree = useMemo(() => buildTree(Object.keys(files ?? {})), [files]);
  const lines = useMemo(() => (selected && files?.[selected] != null ? files[selected]!.split("\n") : []), [selected, files]);

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

      {/* Tabs: preview · files · terminal. */}
      <div className="flex h-12 shrink-0 items-center gap-1 px-3">
        {(
          [
            ["preview", Globe, "Preview"],
            ["files", SquareStack, "Files"],
            ["diff", FileDiff, "Diff"],
            ["terminal", TerminalSquare, "Terminal"],
            ["secrets", KeyRound, "Secrets"],
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            type="button"
            aria-label={label}
            aria-pressed={view === id}
            onClick={() => setView(id)}
            className={cn(
              "premium-control relative flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors",
              view === id ? "bg-chip text-foreground" : "text-muted hover:text-foreground",
            )}
          >
            <Icon className="size-[15px]" />
            <span className="max-sm:hidden">{label}</span>
            {id === "terminal" && commandRunning && <span className="absolute top-1 right-1 size-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden />}
          </button>
        ))}
        <span className="flex-1" />
        <DeployButton conversationId={conversationId} disabled={building} />
        {building && (
          <span className="mr-1 flex items-center gap-1.5 text-xs text-muted">
            <span className="build-orb scale-75" aria-hidden /> <span className="max-sm:hidden">Building</span>
          </span>
        )}
        <button type="button" aria-label="Close canvas" onClick={onClose} className={iconBtn}>
          <PanelRightClose className="size-4" />
        </button>
      </div>

      {view === "preview" ? (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/80 px-3">
          <button type="button" aria-label="Reload" onClick={() => (url ? setNonce((n) => n + 1) : ensure())} className={iconBtn} disabled={!conversationId}>
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
      ) : view === "diff" || view === "secrets" ? null : view === "files" ? (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/80 px-3">
          <button type="button" aria-label="Toggle file list" aria-pressed={showTree} onClick={() => setShowTree((v) => !v)} className={cn(iconBtn, showTree && "bg-chip text-foreground")}>
            <ListTree className="size-3.5" />
          </button>
          <span className="min-w-0 flex-1 truncate px-1 text-sm text-foreground">{selected ?? ""}</span>
          {conversationId && (
            <button type="button" aria-label="Download project" onClick={() => void downloadProjectZip(conversationId).catch((e) => setMessage(e instanceof Error ? e.message : "Download failed"))} className={iconBtn}>
              <Download className="size-3.5" />
            </button>
          )}
        </div>
      ) : (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/80 bg-[#0c0c0d] px-4 font-mono text-[11px] text-[#6b7078]">
          <span className="size-2 rounded-full bg-[#ff5f57]/70" />
          <span className="size-2 rounded-full bg-[#febc2e]/70" />
          <span className="size-2 rounded-full bg-[#28c840]/70" />
          <span className="ml-1">friday@sandbox: ~/app</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {view === "terminal" ? (
          <SessionTerminal steps={steps} building={building} />
        ) : view === "diff" ? (
          <DiffView steps={steps} />
        ) : view === "secrets" ? (
          <SecretsView conversationId={conversationId} />
        ) : view === "preview" ? (
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
          ) : status === "error" ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-danger">
              <pre className="max-h-60 max-w-full overflow-auto text-left text-xs whitespace-pre-wrap">{message}</pre>
              <button type="button" onClick={ensure} className="rounded-full bg-chip px-3 py-1.5 text-xs text-foreground">
                Try again
              </button>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted">
              <Globe className="size-5" />
              {building ? "The live preview appears here the moment the app starts running." : "No preview yet — ask Friday to build and run an app."}
            </div>
          )
        ) : !conversationId ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">No files yet.</div>
        ) : files === null ? (
          <div className="flex h-full items-center justify-center text-muted">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="flex h-full min-h-0">
            {showTree && (
              <div className="w-56 shrink-0 overflow-auto border-r border-border/80 p-2 max-md:w-40">
                <div className="px-2 pb-1 text-xs text-subtle">Files</div>
                {tree.length === 0 && <div className="px-2 py-1 text-xs text-subtle">No files yet</div>}
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
