import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowUp, GitBranch, Hammer, Plus, Square } from "lucide-react";
import { api } from "@/lib/api";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { BuildCanvas } from "@/components/build-preview";
import { MessageThread } from "@/components/message-thread";
import { AskPanel, ASK_MARKER } from "@/components/ask-panel";
import { BuildApprovalCard, BuildModeControls } from "@/components/build-steps";
import { beginStream, endStream, isStreamActive } from "@/lib/chat/active-streams";
import { applyLive, applyLiveStep, clearLive, peekLive, setLiveBuildMeta, setLivePlan, setLivePreview, startLive } from "@/lib/chat/live-stream";
import { createStreamBatcher } from "@/lib/chat/raf-batch";
import { streamMessage } from "@/lib/chat/stream";
import { useChat, type ServerConversation, type ServerMessage } from "@/lib/chat/store";
import type { AskQuestion, BuildEffort, BuildMode } from "@/lib/chat/types";
import { cn, uid } from "@/lib/utils";

/** Dedicated composer for the Build Mode workspace — a real coding-agent panel, deliberately not
 *  the general chat composer (no Think/Search/Canvas/model toggles: those don't apply here). */
function BuildComposer({
  onSend,
  streaming,
}: {
  onSend: (text: string) => void;
  streaming: boolean;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const text = value.trim();
    if (!text || streaming) return;
    setValue("");
    onSend(text);
  }

  return (
    <div className="flex w-full items-end gap-2 rounded-2xl border border-border bg-composer px-3 py-2.5 shadow-[var(--shadow-composer)]">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder="Describe what to build, fix, or change…"
        className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-subtle focus:outline-none"
      />
      <button
        type="button"
        aria-label="Send"
        disabled={!value.trim() || streaming}
        onClick={submit}
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-40"
      >
        {streaming ? <Square className="size-3.5" /> : <ArrowUp className="size-4" />}
      </button>
    </div>
  );
}

/** The Build Mode workspace: a genuinely separate page (not the chat shell) — a sessions rail,
 *  a repository picker, the file-tree/preview canvas as the primary surface, and its own
 *  dedicated composer, styled after dedicated coding-agent workspaces (Claude Code, Cursor).
 *  Opens as a full-screen overlay with a mount-in animation over whatever page was behind it. */
export function BuildWorkspacePage({ conversationId }: { conversationId?: string }) {
  const navigate = useNavigate();
  const { user, isPending } = useCurrentUserState();
  const [sessions, setSessions] = useState<ServerConversation[]>([]);
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [buildMode, setBuildMode] = useState<BuildMode>("auto");
  const [buildEffort, setBuildEffort] = useState<BuildEffort>("medium");
  const [pendingApproval, setPendingApproval] = useState<{ kind: string; label: string; detail?: string } | null>(null);
  const [dismissedAsk, setDismissedAsk] = useState<string | null>(null);
  const loadedConversations = useRef<Set<string>>(new Set());

  const activeId = useChat((s) => s.activeId);
  const chat = useChat((s) => s.chats.find((c) => c.id === s.activeId));
  const streaming = Boolean(chat?.messages.some((m) => m.streaming));
  const empty = !chat || chat.messages.length === 0;
  const lastAssistant = chat?.messages.at(-1)?.role === "assistant" ? chat.messages.at(-1) : undefined;
  const pendingAsk = useMemo(() => {
    return lastAssistant && !lastAssistant.streaming && lastAssistant.build?.ask?.length
      ? { id: lastAssistant.id, questions: lastAssistant.build.ask }
      : null;
  }, [lastAssistant]);

  // Enter this workspace's own chat: find-or-create a local chat wired to this conversationId,
  // same helper the sidebar/suggestion-card use when they create a session.
  useEffect(() => {
    if (!conversationId) return;
    useChat.getState().openBuildSession(conversationId, "Build session");
  }, [conversationId]);

  useEffect(() => {
    if (isPending || !user) return;
    api
      .get<{ sessions: ServerConversation[] }>("/build/sessions")
      .then((res) => setSessions(res.sessions))
      .catch(() => {});
  }, [isPending, user, activeId]);

  useEffect(() => {
    if (isPending || !user || !activeId) return;
    const c = useChat.getState().chats.find((x) => x.id === activeId);
    if (!c?.conversationId || c.messages.length > 0 || loadedConversations.current.has(c.conversationId)) return;
    loadedConversations.current.add(c.conversationId);
    api
      .get<{ messages: ServerMessage[] }>(`/chat/conversations/${c.conversationId}/messages`)
      .then((res) => useChat.getState().loadMessagesInto(activeId, res.messages))
      .catch(() => {});
  }, [activeId, isPending, user]);

  useEffect(() => {
    if (!conversationId) return;
    api
      .get<{ mode: BuildMode; effort: BuildEffort; pendingApproval: { kind: string; label: string; detail?: string } | null }>(
        `/build/${conversationId}/files`,
      )
      .then((res) => {
        setBuildMode(res.mode);
        setBuildEffort(res.effort);
        setPendingApproval(res.pendingApproval);
      })
      .catch(() => {
        // Nothing built yet (brand-new session) — defaults are fine.
      });
  }, [conversationId]);

  // A session created via "Go to Build Mode" (see BuildSuggestionCard) has a prompt queued —
  // send it once this chat is active.
  useEffect(() => {
    const pending = useChat.getState().pendingSend;
    if (!pending || pending.chatId !== activeId) return;
    useChat.getState().setPendingSend(null);
    void send(pending.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  async function send(text: string) {
    const s = useChat.getState();
    const c = s.chats.find((x) => x.id === activeId);
    if (!c?.conversationId || isStreamActive(c.id)) return;
    // A repo picked before the first message ever sent seeds the agent's GitHub import (agent.ts
    // parses a repo URL out of the request text) — only relevant while the project is still empty.
    const seeded = empty && repoUrl.trim() ? `Work on ${repoUrl.trim()}. ${text}` : text;

    const userMsg = { id: uid(), role: "user" as const, content: text, createdAt: Date.now() };
    const { chatId, assistantId } = s.beginTurn(userMsg);
    startLive(chatId, assistantId, "building", false);
    const ac = beginStream(chatId);
    const batch = createStreamBatcher((acc) => applyLive(chatId, acc));
    let askQuestions: AskQuestion[] | undefined;

    try {
      await streamMessage(c.conversationId, seeded, "text", false, "", false, false, [], (ev) => {
        if (ev.t === "status" && ev.s === "building") applyLive(chatId, { text: "", think: "", cites: [], agents: [], status: "building" });
        else if (ev.t === "status") batch.status(ev.s);
        else if (ev.t === "text") batch.text(ev.c);
        else if (ev.t === "step") applyLiveStep(chatId, { id: ev.id, kind: ev.kind, label: ev.label, state: ev.state, detail: ev.detail });
        else if (ev.t === "plan") setLivePlan(chatId, { architecture: ev.architecture, items: ev.items });
        else if (ev.t === "build") setLiveBuildMeta(chatId, { elapsedMs: ev.elapsedMs, zipBytes: ev.zipBytes, zipName: ev.zipName, prUrl: ev.prUrl });
        else if (ev.t === "preview") setLivePreview(chatId, ev.url, ev.port);
        else if (ev.t === "ask") askQuestions = ev.questions;
        else if (ev.t === "mode") {
          setBuildMode(ev.mode);
          setBuildEffort(ev.effort);
        } else if (ev.t === "approval") setPendingApproval(ev.action);
        else if (ev.t === "err") batch.error(ev.c);
      }, ac.signal);
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") {
        applyLive(chatId, { text: "", think: "", cites: [], agents: [], error: err instanceof Error ? err.message : "Something went wrong" });
      }
    } finally {
      batch.flush();
      const live = peekLive(chatId);
      useChat.getState().commitTurn(chatId, assistantId, {
        content: live?.text || (askQuestions ? ASK_MARKER : ""),
        build: askQuestions
          ? { steps: [], ask: askQuestions }
          : live && (live.steps.length || live.preview || live.plan)
            ? { plan: live.plan, steps: live.steps, previewUrl: live.preview?.url, port: live.preview?.port, ...live.meta }
            : undefined,
        error: live?.error,
      });
      clearLive(chatId);
      endStream(chatId, ac);
    }
  }

  async function startNewSession() {
    try {
      const res = await api.post<{ conversationId: string }>("/build/sessions", {});
      void navigate({ to: "/build/$conversationId", params: { conversationId: res.conversationId } });
    } catch {
      // Nothing new appears — no silent-looking navigation.
    }
  }

  const previewUrl = chat?.messages.at(-1)?.build?.previewUrl;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-0 z-40 flex bg-background text-foreground"
    >
      {/* Sessions rail — Build Mode's own session list (not the main app sidebar). */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-elevated/40 md:flex">
        <div className="flex h-14 shrink-0 items-center gap-2 px-4">
          <Hammer className="size-4 text-muted" />
          <span className="text-sm font-semibold">Build Mode</span>
        </div>
        <div className="px-3">
          <button
            type="button"
            onClick={() => void startNewSession()}
            className="premium-control flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-chip-on"
          >
            <Plus className="size-3.5" /> New session
          </button>
        </div>
        <nav className="mt-3 flex-1 overflow-y-auto px-2">
          <p className="px-2 py-1 text-xs font-medium text-subtle">Sessions</p>
          <ul className="flex flex-col gap-0.5">
            {sessions.length === 0 ? (
              <li className="px-2.5 py-1.5 text-xs text-subtle">No sessions yet</li>
            ) : (
              sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => void navigate({ to: "/build/$conversationId", params: { conversationId: s.id } })}
                    className={cn(
                      "premium-control flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left text-sm font-medium hover:bg-chip-on",
                      s.id === conversationId ? "bg-chip-on text-foreground" : "text-muted",
                    )}
                  >
                    <span className="truncate">{s.title}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
          <button
            type="button"
            aria-label="Back to chat"
            onClick={() => void navigate({ to: "/" })}
            className="premium-control flex size-9 items-center justify-center rounded-full text-muted hover:bg-chip-on hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{chat?.title ?? "Build session"}</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setRepoOpen((v) => !v)}
              className="premium-control flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-medium text-foreground hover:bg-chip-on"
            >
              <GitBranch className="size-3.5 text-muted" /> {repoUrl ? repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "") : "Select repository"}
            </button>
            {repoOpen && (
              <div className="absolute top-full right-0 z-10 mt-1 w-72 rounded-xl border border-border bg-elevated p-2 shadow-lg">
                <input
                  autoFocus
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && setRepoOpen(false)}
                  placeholder="github.com/owner/repo"
                  disabled={!empty}
                  className="w-full rounded-lg border border-border bg-composer px-2.5 py-1.5 text-xs text-foreground placeholder:text-subtle focus:outline-none disabled:opacity-50"
                />
                <p className="mt-1.5 px-0.5 text-[11px] text-subtle">
                  {empty ? "Used when you send the first message." : "Only settable before the first message."}
                </p>
              </div>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-[1.6] flex-col border-r border-border">
            {conversationId && !empty ? (
              <BuildCanvas conversationId={conversationId} liveUrl={previewUrl} onClose={() => {}} onResizeStart={() => {}} />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                <Hammer className="size-8 text-subtle" />
                <p className="text-sm text-muted">Send a message to start building — files, terminal and a live preview will show up here.</p>
              </div>
            )}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <MessageThread />
            <div className="shrink-0 px-4 pb-4">
              <BuildModeControls
                conversationId={conversationId}
                mode={buildMode}
                effort={buildEffort}
                onChange={(patch) => {
                  if (patch.mode) setBuildMode(patch.mode);
                  if (patch.effort) setBuildEffort(patch.effort);
                }}
              />
              {pendingApproval && (
                <BuildApprovalCard action={pendingApproval} conversationId={conversationId} onResolved={() => setPendingApproval(null)} />
              )}
              {pendingAsk && dismissedAsk !== pendingAsk.id && (
                <AskPanel questions={pendingAsk.questions} onSubmit={(text) => void send(text)} onDismiss={() => setDismissedAsk(pendingAsk.id)} />
              )}
              <BuildComposer onSend={(text) => void send(text)} streaming={streaming} />
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
