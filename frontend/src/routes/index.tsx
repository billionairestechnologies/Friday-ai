import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
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
import { applyLive, clearLive, markLiveCanvasOn, peekLive, startLive } from "@/lib/chat/live-stream";
import { AUTO_MODEL_ID, TEAMUP_MODEL_ID, decodeModelId, useModels } from "@/lib/chat/models";
import { createStreamBatcher } from "@/lib/chat/raf-batch";
import { streamMessage } from "@/lib/chat/stream";
import { useChat, type ServerConversation, type ServerMessage } from "@/lib/chat/store";
import { extractArtifact } from "@/lib/chat/artifact";
import type { ChatMessage } from "@/lib/chat/types";
import { fileToAttachment } from "@/lib/chat/files";
import { uid } from "@/lib/utils";

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
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
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
    return () => abortRef.current?.abort();
  }, []);

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

  async function send(text: string, files?: File[]) {
    const s = useChat.getState();
    const trimmed = text.trim();
    let attachments = s.attachments;
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
    if (!available || busyRef.current) {
      // A stuck busyRef (an earlier request that never cleared it) used to make every send
      // after it — voice included — silently do nothing forever. Surface it instead.
      setSendError(available ? "Still working on the last message — try again in a moment." : "No models available right now.");
      window.setTimeout(() => setSendError(null), 4000);
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

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    busyRef.current = true;
    setBusy(true);

    let conversationId: string;
    try {
      conversationId = (await ensureConversation(model, chatId)).conversationId;
    } catch (err) {
      useChat.getState().commitTurn(chatId, assistantId, {
        content: "",
        error: err instanceof Error ? err.message : "Couldn't start the conversation",
      });
      clearLive();
      busyRef.current = false;
      setBusy(false);
      return;
    }

    const batch = createStreamBatcher((acc) => {
      applyLive(acc);
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
        markLiveCanvasOn();
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

    try {
      await streamMessage(conversationId, trimmed, "text", s.think, s.behavior, s.webSearch, s.canvas, sendableAttachments, (ev) => {
        if (ev.t === "status") batch.status(ev.s);
        else if (ev.t === "think") batch.think(ev.c);
        else if (ev.t === "text") {
          batch.text(ev.c);
          maybeAutoOpenCanvas(ev.c);
        }
        else if (ev.t === "cite") batch.cite({ url: ev.u, title: ev.title });
        else if (ev.t === "agent") batch.agent({ slug: ev.slug, model: ev.model, state: ev.state, error: ev.error });
        else if (ev.t === "err") batch.error(ev.c);
      }, ac.signal);
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") {
        applyLive({
          text: "",
          think: "",
          cites: [],
          agents: [],
          error: err instanceof Error ? err.message : "Something went wrong",
        });
      }
    } finally {
      batch.flush();
      const live = peekLive();
      useChat.getState().commitTurn(chatId, assistantId, {
        content: live?.text ?? "",
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
      });
      clearLive();
      busyRef.current = false;
      setBusy(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function usePrompt(text: string) {
    void send(text);
  }

  return (
    <div className="relative flex h-dvh overflow-hidden bg-background">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
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
                  streaming={busy}
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
                  <Composer
                    onSend={(message, files) => void send(message, files)}
                    onStop={stop}
                    streaming={busy || streaming}
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
