import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Code2,
  Download,
  Eye,
  ExternalLink,
  Globe,
  PanelRightClose,
  Play,
  RefreshCw,
} from "lucide-react";
import { Markdown } from "@/lib/chat/markdown";
import { extractArtifact, extractStreamingCodeBody, type Artifact } from "@/lib/chat/artifact";
import { extForLang, saveFile } from "@/lib/chat/download";
import { buildReactPreviewHtml } from "@/lib/chat/react-preview";
import { normalizeRunLanguage, runSandboxCode, type AutoRunResult } from "@/lib/chat/runnable";
import { useLiveStream } from "@/lib/chat/live-stream";
import { useChat } from "@/lib/chat/store";

export function CanvasPanel() {
  const open = useChat((s) => s.canvasOpen);
  const setOpen = useChat((s) => s.setCanvasOpen);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className="flex h-full min-w-0"
        >
          <CanvasBody onClose={() => setOpen(false)} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function filenameFor(kind: string, lang?: string) {
  if (kind === "html") return "canvas.html";
  if (kind === "markdown") return "canvas.md";
  return `canvas.${extForLang(lang)}`;
}

/**
 * Python/JS blocks run for real the moment they land — actual execution in the user's own
 * isolated E2B VM (backend's /api/sandbox/run) — and on failure the backend automatically asks
 * a model to fix the code and retries a couple of times before giving up (see e2bService's
 * runWithAutoFix), so a typo in generated code self-heals instead of just handing the user a
 * stack trace. A manual "Run again" re-triggers the same auto-fix loop for edits/flaky runs.
 */
function RunnablePane({ artifact }: { artifact: Artifact }) {
  const [result, setResult] = useState<AutoRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const ranForBody = useRef<string | null>(null);

  const language = normalizeRunLanguage(artifact.lang);

  async function handleRun() {
    if (!language || running) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await runSandboxCode(language, artifact.body);
      setResult(res);
    } catch (err) {
      setResult({
        ok: false,
        output: err instanceof Error ? err.message : "Run failed",
        code: artifact.body,
        attempts: [],
      });
    } finally {
      setRunning(false);
    }
  }

  // Auto-run once per distinct artifact body (a fresh message, or the same one re-streamed) —
  // not on every re-render, and not again just because the user switched Canvas tabs and back.
  useEffect(() => {
    if (ranForBody.current === artifact.body) return;
    ranForBody.current = artifact.body;
    void handleRun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.body]);

  const displayedCode = result?.code ?? artifact.body;
  const wasFixed = Boolean(result && result.code !== artifact.body);
  const failedAttempts = result ? result.attempts.filter((a) => !a.result.ok).length : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <span className="text-xs text-muted">
          {artifact.lang}
          {wasFixed && " · auto-fixed"}
        </span>
        <button
          type="button"
          onClick={() => void handleRun()}
          disabled={!language || running}
          className="flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {running ? <RefreshCw className="size-3 animate-spin" /> : <Play className="size-3" />}
          {running ? (failedAttempts ? "Fixing & retrying…" : "Running…") : "Run again"}
        </button>
      </div>
      <pre className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-muted whitespace-pre-wrap">
        {displayedCode}
      </pre>
      {result && (
        <div className="max-h-64 shrink-0 overflow-auto border-t border-border p-4">
          {failedAttempts > 0 && (
            <div className="mb-2 text-xs text-muted">
              {failedAttempts} failed attempt{failedAttempts === 1 ? "" : "s"} auto-fixed before
              this {result.ok ? "run succeeded" : "final run"}.
            </div>
          )}
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
            {result.ok ? (
              <span className="text-muted">Output</span>
            ) : (
              <span className="flex items-center gap-1 text-red-500">
                <AlertTriangle className="size-3" /> Error (couldn't auto-fix)
              </span>
            )}
          </div>
          <pre
            className={`font-mono text-xs leading-relaxed whitespace-pre-wrap ${
              result.ok ? "text-foreground" : "text-red-500"
            }`}
          >
            {result.output || "(no output)"}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Live "writing code" view — raw source with a blinking cursor, auto-scrolling to the bottom as
 *  it grows, so Canvas shows the code actually being typed out instead of a bare spinner for the
 *  whole time it's being generated. Used both while streaming (partial, open fence) and as the
 *  Code tab's content once the artifact is complete. */
function LiveCode({ lang, body, live }: { lang?: string; body: string; live: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!live) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [body, live]);

  return (
    <pre
      ref={ref}
      className="h-full overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground"
    >
      {lang && <span className="mb-2 block text-[11px] text-subtle">{lang}</span>}
      {body}
      {live && <span className="stream-caret" aria-hidden />}
    </pre>
  );
}

function CanvasBody({ onClose }: { onClose: () => void }) {
  const liveAll = useLiveStream();
  const activeId = useChat((s) => s.activeId);
  const live = liveAll && liveAll.chatId === activeId ? liveAll : null;
  const stored = useChat((s) => {
    const chat = s.chats.find((c) => c.id === s.activeId);
    const list = chat?.messages ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]!;
      if (m.role === "assistant") return m.content;
    }
    return "";
  });
  const content = live?.text || stored;
  const streaming = Boolean(live);
  const artifact = content ? extractArtifact(content) : null;
  // Covers both a manually-toggled Canvas build and an auto-opened one (see routes/index.tsx) —
  // purely content-driven (an open code fence) rather than gated on the Canvas toggle having been
  // on, so the live "writing" view below shows in either case.
  const streamingCode = !artifact && streaming ? extractStreamingCodeBody(content) : null;
  const building = streaming && !artifact;
  // Only html/react have a real "Preview" to toggle back to — everything else (code/runnable/
  // markdown) only ever has one view.
  const [view, setView] = useState<"preview" | "code">("preview");
  const hasPreview = artifact?.kind === "html" || artifact?.kind === "react";

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-l border-border bg-background max-md:fixed max-md:inset-0 max-md:z-40 md:w-[min(100%,28rem)] lg:w-[32rem]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Globe className="size-3.5 text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {artifact?.title ?? "Canvas"}
        </span>
        {hasPreview && (
          <div className="flex items-center rounded-full bg-chip p-0.5">
            <button
              type="button"
              onClick={() => setView("preview")}
              aria-pressed={view === "preview"}
              className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                view === "preview" ? "bg-background text-foreground shadow-sm" : "text-muted hover:text-foreground"
              }`}
            >
              <Eye className="size-3" />
              Preview
            </button>
            <button
              type="button"
              onClick={() => setView("code")}
              aria-pressed={view === "code"}
              className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                view === "code" ? "bg-background text-foreground shadow-sm" : "text-muted hover:text-foreground"
              }`}
            >
              <Code2 className="size-3" />
              Code
            </button>
          </div>
        )}
        {artifact && (
          <button
            type="button"
            aria-label="Download canvas"
            onClick={() =>
              void saveFile(filenameFor(artifact.kind, artifact.lang), artifact.body)
            }
            className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground"
          >
            <Download className="size-3.5" />
          </button>
        )}
        {(artifact?.kind === "html" || artifact?.kind === "react") && (
          <button
            type="button"
            aria-label="Open in new tab"
            onClick={() => {
              const html = artifact.kind === "react" ? buildReactPreviewHtml(artifact.body) : artifact.body;
              const blob = new Blob([html], { type: "text/html;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              window.open(url, "_blank", "noopener,noreferrer");
              window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
            }}
            className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          aria-label="Close canvas"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground"
        >
          <PanelRightClose className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <AnimatePresence mode="wait">
          {building && streamingCode ? (
            <motion.div
              key="streaming-code"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="h-full"
            >
              <LiveCode lang={streamingCode.lang} body={streamingCode.body} live />
            </motion.div>
          ) : building && !artifact ? (
            <motion.div
              key="building"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted"
            >
              <RefreshCw className="size-4 animate-spin" />
              Building on canvas…
            </motion.div>
          ) : artifact?.kind === "html" && view === "code" ? (
            <motion.div
              key="html-code"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              <LiveCode lang={artifact.lang} body={artifact.body} live={false} />
            </motion.div>
          ) : artifact?.kind === "html" ? (
            <motion.iframe
              key="html"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.22 }}
              title="Canvas"
              sandbox="allow-scripts"
              srcDoc={artifact.body}
              className="h-full min-h-[24rem] w-full border-0 bg-white"
            />
          ) : artifact?.kind === "react" && view === "code" ? (
            <motion.div
              key="react-code"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              <LiveCode lang={artifact.lang} body={artifact.body} live={false} />
            </motion.div>
          ) : artifact?.kind === "react" ? (
            <motion.iframe
              key="react"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.22 }}
              title="Canvas"
              sandbox="allow-scripts"
              srcDoc={buildReactPreviewHtml(artifact.body)}
              className="h-full min-h-[24rem] w-full border-0 bg-white"
            />
          ) : artifact?.kind === "runnable" ? (
            <motion.div
              key="runnable"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              <RunnablePane artifact={artifact} />
            </motion.div>
          ) : artifact?.kind === "code" ? (
            <motion.pre
              key="code"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="p-4 font-mono text-xs leading-relaxed text-muted whitespace-pre-wrap"
            >
              {artifact.body}
            </motion.pre>
          ) : artifact?.kind === "markdown" ? (
            <motion.div
              key="markdown"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="p-5"
            >
              <Markdown text={artifact.body} />
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18 }}
              className="flex h-full items-center justify-center px-6 text-center text-sm text-subtle"
            >
              Turn on Canvas and ask Friday to build something — the output lands here.
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </aside>
  );
}
