import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Composer } from "@/components/composer";
import { MessageThread } from "@/components/message-thread";
import { HeaderActions, Popouts } from "@/components/popouts";
import { CompleteProfileModal } from "@/components/complete-profile-modal";
import { Sidebar, SidebarToggle } from "@/components/sidebar";
import { useGreeting, useHeroLine } from "@/hooks/use-greeting";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { applyLive, applyLiveStep, clearLive, markLiveCanvasOn, peekLive, setLiveBuildMeta, setLivePlan, setLivePreview, startLive } from "@/lib/chat/live-stream";
import { beginStream, endStream, isStreamActive, stopStream } from "@/lib/chat/active-streams";
import { AUTO_MODEL_ID, TEAMUP_MODEL_ID, decodeModelId, useModels } from "@/lib/chat/models";
import { createStreamBatcher } from "@/lib/chat/raf-batch";
import { streamMessage } from "@/lib/chat/stream";
import { useChat, type ServerConversation, type ServerMessage } from "@/lib/chat/store";
import { extractArtifact } from "@/lib/chat/artifact";
import type { AskQuestion, ChatMessage } from "@/lib/chat/types";
import { AskPanel, ASK_MARKER } from "@/components/ask-panel";
import { fileToAttachment } from "@/lib/chat/files";
import { uid } from "@/lib/utils";
import { useQueue } from "@/lib/chat/queue";
import { X } from "lucide-react";
import { SITE_NAV } from "@/lib/site/pages";

type ConversationMode = "single" | "auto" | "teamup";

const CanvasPanel = lazy(() =>
  import("@/components/canvas-panel").then((module) => ({ default: module.CanvasPanel })),
);

const PROMPTS = [
  "Catch me up on the biggest stories today",
  "Explain how transformers work, simply",
  "Plan a 3-day trip to Lisbon",
  "Write a Python script that renames files in bulk",
];

function modeForModel(model: string): ConversationMode {
  if (model === AUTO_MODEL_ID) return "auto";
  if (model === TEAMUP_MODEL_ID) return "teamup";
  return "single";
}

export function Home({ conversationId }: { conversationId?: string } = {}) {
  const navigate = useNavigate();
  const greeting = useGreeting();
  const { user, isPending } = useCurrentUserState();
  const firstName = user?.displayName?.trim().split(/\s+/)[0];
  const heroLine = useHeroLine(greeting, firstName, user?.birthday);
  const models = useModels((s) => s.models);
  const loadModels = useModels((s) => s.load);
  const available = models.length > 2; // beyond the Auto/Team Up sentinels

  const empty = useChat((s) => {
    const chat = s.chats.find((c) => c.id === s.activeId);
    return !chat || chat.messages.length === 0;
  });
  const title = useChat((s) => {
    const chat = s.chats.find((c) => c.id === s.activeId);
    return chat?.title ?? "New chat";
  });
  const streaming = useChat((s) =>
    Boolean(s.chats.find((c) => c.id === s.activeId)?.messages.some((m) => m.streaming)),
  );
  const activeId = useChat((s) => s.activeId);
  // Build Mode question round: the newest message is an unanswered set of questions.
  // Select the message itself (a stable reference from the store) rather than building a new
  // { id, questions } object inline — a selector that returns a fresh object on every call makes
  // useSyncExternalStore think the store changed on every render, which forces another render,
  // which builds another fresh object... an infinite loop that surfaces as React error #185.
  const lastAssistantMessage = useChat((s) => {
    const last = s.chats.find((c) => c.id === s.activeId)?.messages.at(-1);
    return last?.role === "assistant" ? last : undefined;
  });
  const pendingAsk = useMemo(() => {
    const last = lastAssistantMessage;
    return last && !last.streaming && last.build?.ask?.length ? { id: last.id, questions: last.build.ask } : null;
  }, [lastAssistantMessage]);
  const [dismissedAsk, setDismissedAsk] = useState<string | null>(null);
  const queued = useQueue((s) => (activeId ? s.byChat[activeId] : undefined)) ?? [];
  const [sendError, setSendError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const loadedConversations = useRef<Set<string>>(new Set());

  useEffect(() => {
    void loadModels();
    // Wait for auth bootstrap to finish restoring the access token — firing this before it
    // resolves races the token and hits the backend with no/stale Authorization header.
    if (isPending || !user) return;
    api
      .get<{ conversations: ServerConversation[] }>("/chat/conversations")
      .then((res) => {
        useChat.getState().hydrateFromServer(res.conversations);
        setSyncError(null);
      })
      .catch((err) => setSyncError(err instanceof Error ? err.message : "Couldn't sync conversations"));
  }, [loadModels, isPending, user]);

  useEffect(() => {
    if (window.innerWidth < 768) useChat.getState().setSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    useChat.getState().selectConversation(conversationId);
  }, [conversationId]);

  useEffect(() => {
    if (isPending || !user) return;
    if (!activeId) return;
    const chat = useChat.getState().chats.find((c) => c.id === activeId);
    if (!chat?.conversationId) return;
    if (chat.messages.length > 0) return;
    if (loadedConversations.current.has(chat.conversationId)) return;
    loadedConversations.current.add(chat.conversationId);
    api
      .get<{ messages: ServerMessage[] }>(`/chat/conversations/${chat.conversationId}/messages`)
      .then((res) => {
        useChat.getState().loadMessagesInto(activeId, res.messages);
        setSyncError(null);
      })
      .catch((err) => setSyncError(err instanceof Error ? err.message : "Couldn't load messages"));
  }, [activeId, isPending, user]);

  // A chat can be left with a trailing user message and no reply — e.g. a scheduled automation
  // posted the prompt and generated a reply server-side while this tab was closed/backgrounded, and
  // the realtime INSERT for it never landed here. beginTurn() always appends [user, assistant] as a
  // pair for a live in-tab send, so an unpaired trailing user message with nothing streaming means
  // this tab never saw the reply come in — refetch it whenever the chat becomes visible again.
  useEffect(() => {
    if (isPending || !user) return;
    function checkForMissedReply() {
      if (document.visibilityState !== "visible") return;
      const id = useChat.getState().activeId;
      if (!id) return;
      const chat = useChat.getState().chats.find((c) => c.id === id);
      if (!chat?.conversationId) return;
      const last = chat.messages.at(-1);
      // An unanswered trailing user message, or an assistant turn that ended in a local error
      // (network blip closing the tab mid-stream — the backend keeps generating and persists the
      // full reply regardless, see activeGenerations.ts) — both mean this tab's view is stale.
      if (!last || !(last.role === "user" || (last.role === "assistant" && last.error))) return;
      if (chat.messages.some((m) => m.streaming)) return;
      api
        .get<{ messages: ServerMessage[] }>(`/chat/conversations/${chat.conversationId}/messages`)
        .then((res) => useChat.getState().loadMessagesInto(chat.id, res.messages))
        .catch(() => {
          /* next focus, or a realtime event, will retry */
        });
    }
    checkForMissedReply();
    document.addEventListener("visibilitychange", checkForMissedReply);
    window.addEventListener("focus", checkForMissedReply);
    return () => {
      document.removeEventListener("visibilitychange", checkForMissedReply);
      window.removeEventListener("focus", checkForMissedReply);
    };
  }, [activeId, isPending, user]);

  // `chatId` is always an already-existing local chat here — the caller runs `beginTurn()`
  // (which appends the optimistic user+assistant messages) before this, specifically so that
  // when a brand-new conversation is created and we navigate to /c/$id below, the resulting
  // remount of Home (it's a genuinely different route component, see router.tsx) finds a
  // non-empty message list and its "load messages from server" effect bails out instead of
  // racing this function's setConversationId and clobbering the still-streaming reply.
  async function ensureConversation(model: string, chatId: string): Promise<{ conversationId: string }> {
    const s = useChat.getState();
    const chat = s.chats.find((c) => c.id === chatId);
    const mode = modeForModel(model);

    if (chat?.conversationId) {
      if (!conversationId || conversationId !== chat.conversationId) {
        void navigate({ to: "/c/$conversationId", params: { conversationId: chat.conversationId } });
      }
      // Same conversation, but the user picked a different model since the last message —
      // switch the conversation over to it so the next reply actually comes from that model
      // instead of silently continuing on whatever it was created with.
      if (chat.conversationModel !== model) {
        const body: { mode: ConversationMode; providerSlug?: string; modelId?: string } = { mode };
        if (mode === "single") {
          const decoded = decodeModelId(model);
          if (!decoded) throw new Error("Pick a model first");
          body.providerSlug = decoded.providerSlug;
          body.modelId = decoded.modelId;
        }
        await api.patch(`/chat/conversations/${chat.conversationId}`, body);
        useChat.getState().setConversationModel(chat.id, model);
      }
      return { conversationId: chat.conversationId };
    }

    const body: { mode: ConversationMode; providerSlug?: string; modelId?: string; projectId?: string } = { mode };
    if (s.activeProjectId) body.projectId = s.activeProjectId;
    if (mode === "single") {
      const decoded = decodeModelId(model);
      if (!decoded) throw new Error("Pick a model first");
      body.providerSlug = decoded.providerSlug;
      body.modelId = decoded.modelId;
    }
    const res = await api.post<{ conversation: { id: string } }>("/chat/conversations", body);
    useChat.getState().setConversationId(chatId, res.conversation.id, s.activeProjectId ?? undefined);
    useChat.getState().setConversationModel(chatId, model);
    void navigate({ to: "/c/$conversationId", params: { conversationId: res.conversation.id } });
    return { conversationId: res.conversation.id };
  }

  async function send(text: string, files?: File[], queuedAttachments?: ChatMessage["attachments"]) {
    const s = useChat.getState();
    const trimmed = text.trim();
    let attachments = queuedAttachments ?? s.attachments;
    if (files?.length) {
      try {
        attachments = await Promise.all(files.map(fileToAttachment));
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Couldn't attach that file");
        window.setTimeout(() => setSendError(null), 4000);
        return;
      }
    }
    if (!trimmed && attachments.length === 0) return;
    // Only blocks re-sending into the SAME chat that's already streaming — a global busy flag
    // here used to refuse sending into any OTHER chat too (and a stuck one made every send
    // forever after do nothing silently), which is exactly what broke multitasking across chats.
    if (!available) {
      setSendError("No models available right now.");
      window.setTimeout(() => setSendError(null), 4000);
      return;
    }
    // A reply is still generating in this chat: park the message in the queue instead of
    // refusing it. It sends automatically, in order, when the current turn finishes.
    if (s.activeId && isStreamActive(s.activeId)) {
      if (!queuedAttachments) s.clearDraft();
      useQueue.getState().enqueue(s.activeId, { id: uid(), text: trimmed, attachments });
      return;
    }

    if (!useAuthStore.getState().user) {
      s.setDialog("login");
      return;
    }

    const model = s.model;
    s.clearDraft();

    const user: ChatMessage = {
      id: uid(),
      role: "user",
      content: trimmed,
      attachments: attachments.length ? attachments : undefined,
      createdAt: Date.now(),
    };

    // Append the optimistic user+assistant turn locally FIRST, before any network call or
    // navigation — ensureConversation (for a brand-new chat) navigates to /c/$conversationId,
    // which remounts Home on a different route component. If that remount's "load messages
    // from server" effect ran while this chat's local message list was still empty, it would
    // overwrite it with the server's (assistant-less) snapshot and orphan the live stream for
    // good — see ensureConversation's comment. Doing this first means the effect always sees a
    // non-empty list, regardless of how the remount race lands.
    const { chatId, assistantId } = useChat.getState().beginTurn(user);
    const initial =
      useChat.getState().chats.find((c) => c.id === chatId)?.messages.find((m) => m.id === assistantId)
        ?.status ?? "working";
    startLive(chatId, assistantId, initial, s.canvas);
    const ac = beginStream(chatId);

    let conversationId: string;
    try {
      conversationId = (await ensureConversation(model, chatId)).conversationId;
    } catch (err) {
      useChat.getState().commitTurn(chatId, assistantId, {
        content: "",
        error: err instanceof Error ? err.message : "Couldn't start the conversation",
      });
      clearLive(chatId);
      endStream(chatId, ac);
      return;
    }

    const batch = createStreamBatcher((acc) => {
      applyLive(chatId, acc);
    });

    // Auto-canvas: open the panel the moment the reply is actually producing a visual artifact
    // (a full HTML page or a React component — the two kinds meant to be previewed, not an
    // ordinary inline code snippet), instead of requiring the Canvas toggle beforehand. Skipped
    // when Canvas was already manually on (beginTurn already opened the panel for that case).
    let streamedText = "";
    let autoCanvasOpened = s.canvas;
    function maybeAutoOpenCanvas(delta: string) {
      if (autoCanvasOpened) return;
      streamedText += delta;
      const artifact = extractArtifact(streamedText);
      if (artifact && (artifact.kind === "html" || artifact.kind === "react" || artifact.kind === "runnable")) {
        autoCanvasOpened = true;
        useChat.getState().setCanvasOpen(true);
        markLiveCanvasOn(chatId);
      }
    }

    // Images/PDF/DOCX/XLSX actually reach the backend. Every model can read a PDF or image via
    // Sarvam's Doc AI OCR the backend runs server-side (a PDF-native provider — Anthropic direct,
    // Gemini — also gets the raw file as a fallback); DOCX/XLSX are parsed directly server-side,
    // no OCR needed. Anything else picked via drag-and-drop (the file picker itself only offers
    // these four) is dropped here before it ever leaves the client.
    const OFFICE_MIMES = new Set([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]);
    const sendableAttachments = attachments
      .filter((a) => a.mime.startsWith("image/") || a.mime === "application/pdf" || OFFICE_MIMES.has(a.mime))
      .map((a) => ({ mime: a.mime, dataUrl: a.dataUrl, name: a.name, size: a.size, kind: a.kind }));

    let askQuestions: AskQuestion[] | undefined;
    try {
      await streamMessage(conversationId, trimmed, "text", s.think, s.behavior, s.webSearch, s.canvas, sendableAttachments, (ev) => {
        if (ev.t === "status" && ev.s === "building") applyLive(chatId, { text: "", think: "", cites: [], agents: [], status: "building" });
        else if (ev.t === "status") batch.status(ev.s);
        else if (ev.t === "think") batch.think(ev.c);
        else if (ev.t === "text") {
          batch.text(ev.c);
          maybeAutoOpenCanvas(ev.c);
        }
        else if (ev.t === "cite") batch.cite({ url: ev.u, title: ev.title });
        else if (ev.t === "agent") batch.agent({ slug: ev.slug, model: ev.model, state: ev.state, error: ev.error });
        else if (ev.t === "step") applyLiveStep(chatId, { id: ev.id, kind: ev.kind, label: ev.label, state: ev.state, detail: ev.detail });
        else if (ev.t === "ask") askQuestions = ev.questions;
        else if (ev.t === "plan") setLivePlan(chatId, { architecture: ev.architecture, items: ev.items });
        else if (ev.t === "build") setLiveBuildMeta(chatId, { elapsedMs: ev.elapsedMs, zipBytes: ev.zipBytes, zipName: ev.zipName, prUrl: ev.prUrl });
        else if (ev.t === "preview") {
          setLivePreview(chatId, ev.url, ev.port);
          // Build Mode produced a running app — open the panel on it, same as an auto-opened artifact.
          useChat.getState().setCanvasOpen(true);
        } else if (ev.t === "err") batch.error(ev.c);
      }, ac.signal, { research: s.research });
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") {
        applyLive(chatId, {
          text: "",
          think: "",
          cites: [],
          agents: [],
          error: err instanceof Error ? err.message : "Something went wrong",
        });
      }
    } finally {
      batch.flush();
      const live = peekLive(chatId);
      useChat.getState().commitTurn(chatId, assistantId, {
        content: live?.text || (askQuestions ? ASK_MARKER : ""),
        thinking: live?.think,
        citations: live?.cites,
        agents: live?.agents,
        error: live?.error,
        // Citations only ever arrive when a search actually ran — a reliable persisted signal
        // even if status has since moved on to "thinking"/"writing" by the time streaming ends.
        // Covers auto-triggered search (Search toggle off, backend judged it was needed) same as
        // manual, so the chain-of-thought/sources panel still renders after the turn completes.
        usedSearch: Boolean(live?.cites?.length),
        usedCanvas: live?.canvasOn,
        build: askQuestions
          ? { steps: [], ask: askQuestions }
          : live && (live.steps.length || live.preview || live.plan)
          ? { plan: live.plan, steps: live.steps, previewUrl: live.preview?.url, port: live.preview?.port, ...live.meta }
          : undefined,
      });
      clearLive(chatId);
      endStream(chatId, ac);
      const next = useQueue.getState().shift(chatId);
      if (next) void send(next.text, undefined, next.attachments ?? []);
    }
  }

  function stop() {
    if (!activeId) return;
    stopStream(activeId);
    // The server keeps generating after a disconnect, so aborting the fetch is no longer enough.
    const conversationId = useChat.getState().chats.find((c) => c.id === activeId)?.conversationId;
    if (conversationId) void api.post(`/chat/conversations/${conversationId}/stop`, {}).catch(() => {});
  }

  function usePrompt(text: string) {
    void send(text);
  }

  return (
    <div className="relative flex h-dvh overflow-hidden bg-background">
      <Sidebar />
      <div className="flex min-w-[320px] flex-1 shrink flex-col">
        <header className="flex h-14 shrink-0 items-center gap-1 px-3">
          <SidebarToggle />
          <span className="min-w-0 flex-1 truncate text-sm text-muted">{title}</span>
          <HeaderActions />
        </header>
        {syncError && (
          <div className="mx-4 mb-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger md:mx-6">
            {syncError}
          </div>
        )}

        <AnimatePresence mode="wait" initial={false}>
          {empty ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="relative z-0 flex flex-1 flex-col items-center justify-center px-4 pb-8"
            >
              <div className="ambient-glow ambient-glow-breathe" aria-hidden />
              <div className="relative z-10 mb-8 flex flex-col items-center text-center">
                {available ? (
                  <h1 className="relative text-balance text-4xl font-medium tracking-tight text-foreground sm:text-5xl md:text-6xl">
                    {heroLine.kind === "greeting" ? (
                      <>
                        <motion.span
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.56, ease: [0.2, 0, 0, 1] }}
                          className="block text-muted"
                        >
                          {heroLine.greeting}
                          {heroLine.name ? "," : ""}
                        </motion.span>
                        {heroLine.name && (
                          <motion.span
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.56, delay: 0.08, ease: [0.2, 0, 0, 1] }}
                            className="block text-foreground"
                          >
                            {heroLine.name}
                          </motion.span>
                        )}
                      </>
                    ) : (
                      <motion.span
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.56, ease: [0.2, 0, 0, 1] }}
                        className="block text-foreground"
                      >
                        {heroLine.text}
                      </motion.span>
                    )}
                  </h1>
                ) : (
                  <>
                    <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
                      No models enabled yet
                    </h1>
                    <p className="mt-2 max-w-md text-pretty text-sm text-muted">
                      Ask an admin to add a provider key in the admin panel.
                    </p>
                  </>
                )}
              </div>
              <div className="relative z-10 w-full max-w-2xl">
                <Composer
                  onSend={(message, files) => void send(message, files)}
                  onStop={stop}
                  streaming={streaming}
                  disabled={!available}
                />
                {available && (
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {PROMPTS.map((p, i) => (
                      <motion.button
                        key={p}
                        type="button"
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(i * 0.08, 0.15), duration: 0.56, ease: [0.2, 0, 0, 1] }}
                        onClick={() => usePrompt(p)}
                        className="premium-control rounded-xl border border-border bg-elevated px-3.5 py-3 text-left text-sm text-muted shadow-[var(--shadow-soft)] hover:bg-chip hover:text-foreground"
                      >
                        {p}
                      </motion.button>
                    ))}
                  </div>
                )}
                {!isPending && !(user && !user.isDevFallback) && (
                  <nav className="mt-8 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-subtle" aria-label="About Friday">
                    {SITE_NAV.map((item) => (
                      <Link key={item.to} to={item.to} className="hover:text-foreground">
                        {item.label}
                      </Link>
                    ))}
                  </nav>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="conversation"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <MessageThread />
              <div className="relative shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">
                <div className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-b from-transparent to-background" />
                <div className="mx-auto w-full max-w-3xl lg:max-w-4xl 2xl:max-w-5xl">
                  {queued.length > 0 && (
                    <div className="mb-2 flex flex-col gap-1.5">
                      {queued.map((q, i) => (
                        <div
                          key={q.id}
                          className="flex items-center gap-2 rounded-xl border border-border bg-composer px-3 py-1.5 text-sm text-muted"
                        >
                          <span className="shrink-0 text-xs text-subtle">Queued {i + 1}</span>
                          <span className="min-w-0 flex-1 truncate">{q.text || "Attachment"}</span>
                          <button
                            type="button"
                            aria-label="Remove queued message"
                            onClick={() => activeId && useQueue.getState().remove(activeId, q.id)}
                            className="rounded-full p-1 hover:bg-chip hover:text-foreground"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {pendingAsk && dismissedAsk !== pendingAsk.id && (
                    <AskPanel questions={pendingAsk.questions} onSubmit={(text) => void send(text)} onDismiss={() => setDismissedAsk(pendingAsk.id)} />
                  )}
                  <Composer
                    onSend={(message, files) => void send(message, files)}
                    onStop={stop}
                    streaming={streaming}
                    disabled={!available}
                  />
                  <p className="pt-2 pb-1 text-center text-xs text-subtle">
                    Friday can be wrong. Check anything important.
                  </p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <Suspense fallback={null}>
        <CanvasPanel />
      </Suspense>
      <Popouts />
      <CompleteProfileModal />
      {sendError && (
        <div className="fixed bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-full border border-border bg-elevated px-4 py-2 text-sm text-danger shadow-[var(--shadow-panel)]">
          {sendError}
        </div>
      )}
    </div>
  );
}
