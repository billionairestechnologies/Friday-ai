import { AnimatePresence, motion } from "framer-motion";
import { Download, ExternalLink, Globe, PanelRightClose, RefreshCw } from "lucide-react";
import { Markdown } from "@/lib/chat/markdown";
import { extractArtifact } from "@/lib/chat/artifact";
import { extForLang, saveFile } from "@/lib/chat/download";
import { buildReactPreviewHtml } from "@/lib/chat/react-preview";
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
  const usedCanvas = useChat((s) => {
    const chat = s.chats.find((c) => c.id === s.activeId);
    const list = chat?.messages ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]!;
      if (m.role === "assistant") return Boolean(m.usedCanvas);
    }
    return false;
  });
  const content = live?.text || stored;
  const building = Boolean(live && usedCanvas);
  const artifact = content ? extractArtifact(content) : null;

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-l border-border bg-background max-md:fixed max-md:inset-0 max-md:z-40 md:w-[min(100%,28rem)] lg:w-[32rem]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Globe className="size-3.5 text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {artifact?.title ?? "Canvas"}
        </span>
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
          {building && !artifact ? (
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
