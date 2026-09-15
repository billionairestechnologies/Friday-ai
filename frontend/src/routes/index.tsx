import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Composer } from "@/components/composer";
import { CanvasPanel } from "@/components/canvas-panel";
import { MessageThread } from "@/components/message-thread";
import { HeaderActions, Popouts } from "@/components/popouts";
import { CompleteProfileModal } from "@/components/complete-profile-modal";
import { Sidebar, SidebarToggle } from "@/components/sidebar";
import { useGreeting, useHeroLine } from "@/hooks/use-greeting";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { applyLive, clearLive, peekLive, startLive } from "@/lib/chat/live-stream";
import { AUTO_MODEL_ID, TEAMUP_MODEL_ID, decodeModelId, useModels } from "@/lib/chat/models";
import { createStreamBatcher } from "@/lib/chat/raf-batch";
import { streamMessage } from "@/lib/chat/stream";
import { useChat, type ServerConversation, type ServerMessage } from "@/lib/chat/store";
import type { ChatMessage } from "@/lib/chat/types";
import { fileToAttachment } from "@/lib/chat/files";
import { uid } from "@/lib/utils";

type ConversationMode = "single" | "auto" | "teamup";

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

export function Home() {
  const greeting = useGreeting();
  const { user } = useCurrentUserState();
  const firstName = user?.displayName?.trim().split(/\s+/)[0];
  const heroLine = useHeroLine(greeting, firstName);
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
  const loadedConversations = useRef<Set<string>>(new Set());

  useEffect(() => {
    void loadModels();
    api
      .get<{ conversations: ServerConversation[] }>("/chat/conversations")
      .then((res) => useChat.getState().hydrateFromServer(res.conversations))
      .catch(() => {});
  }, [loadModels]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (window.innerWidth < 768) useChat.getState().setSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (!activeId) return;
    const chat = useChat.getState().chats.find((c) => c.id === activeId);
    if (!chat?.conversationId) return;
    if (chat.messages.length > 0) return;
    if (loadedConversations.current.has(chat.conversationId)) return;
    loadedConversations.current.add(chat.conversationId);
    api
      .get<{ messages: ServerMessage[] }>(`/chat/conversations/${chat.conversationId}/messages`)
      .then((res) => useChat.getState().loadMessagesInto(activeId, res.messages))
      .catch(() => {});
  }, [activeId]);

  async function ensureConversation(model: string): Promise<{ chatId: string; conversationId: string }> {
    const s = useChat.getState();
    const chat = s.chats.find((c) => c.id === s.activeId);
    const mode = modeForModel(model);

    if (chat?.conversationId) {
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
      return { chatId: chat.id, conversationId: chat.conversationId };
    }

    const body: { mode: ConversationMode; providerSlug?: string; modelId?: string } = { mode };
    if (mode === "single") {
      const decoded = decodeModelId(model);
      if (!decoded) throw new Error("Pick a model first");
      body.providerSlug = decoded.providerSlug;
      body.modelId = decoded.modelId;
    }
    const res = await api.post<{ conversation: { id: string } }>("/chat/conversations", body);

    if (chat) {
      useChat.getState().setConversationId(chat.id, res.conversation.id);
      useChat.getState().setConversationModel(chat.id, model);
      return { chatId: chat.id, conversationId: res.conversation.id };
    }
    // No local chat yet — the caller appends the user message right after this,
    // which creates one; tag it once that happens (see send()).
    return { chatId: "", conversationId: res.conversation.id };
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
    if (!available || busyRef.current) return;

    if (!useAuthStore.getState().user) {
      s.setDialog("login");
      return;
    }

    const model = s.model;
    s.clearDraft();

    let conversationId: string;
    try {
      conversationId = (await ensureConversation(model)).conversationId;
    } catch (err) {
      const user: ChatMessage = {
        id: uid(),
        role: "user",
        content: trimmed,
        attachments: attachments.length ? attachments : undefined,
        createdAt: Date.now(),
      };
      const { chatId } = useChat.getState().appendUserMessage(user);
      useChat.getState().appendAssistantReplies(chatId, [
        { content: err instanceof Error ? err.message : "Couldn't start the conversation", modelLabel: "Error" },
      ]);
      return;
    }

    const user: ChatMessage = {
      id: uid(),
      role: "user",
      content: trimmed,
      attachments: attachments.length ? attachments : undefined,
      createdAt: Date.now(),
    };

    const { chatId, assistantId } = useChat.getState().beginTurn(user);
    useChat.getState().setConversationId(chatId, conversationId);
    useChat.getState().setConversationModel(chatId, model);
    const initial =
      useChat.getState().chats.find((c) => c.id === chatId)?.messages.find((m) => m.id === assistantId)
        ?.status ?? "working";
    startLive(chatId, assistantId, initial);

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    busyRef.current = true;
    setBusy(true);

    const batch = createStreamBatcher((acc) => {
      applyLive(acc);
    });

    try {
      await streamMessage(conversationId, trimmed, "text", s.think, s.behavior, s.webSearch, (ev) => {
        if (ev.t === "status") batch.status(ev.s);
        else if (ev.t === "think") batch.think(ev.c);
        else if (ev.t === "text") batch.text(ev.c);
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
        error: live?.error,
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
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-1 px-3">
          <SidebarToggle />
          <span className="min-w-0 flex-1 truncate text-sm text-muted">{title}</span>
          <HeaderActions />
        </header>

        <AnimatePresence mode="wait" initial={false}>
          {empty ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-1 flex-col items-center justify-center px-4 pb-8"
            >
              <div className="mb-8 flex flex-col items-center text-center">
                {available ? (
                  <h1 className="text-balance text-4xl font-bold tracking-tight text-foreground sm:text-5xl md:text-6xl">
                    {heroLine.kind === "greeting" ? (
                      <>
                        <motion.span
                          initial={{ opacity: 0, y: 14 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                          className="block text-muted"
                        >
                          {heroLine.greeting}
                          {heroLine.name ? "," : ""}
                        </motion.span>
                        {heroLine.name && (
                          <motion.span
                            initial={{ opacity: 0, y: 18, scale: 0.94 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            transition={{ duration: 0.55, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
                            className="block bg-gradient-to-r from-foreground to-foreground/60 bg-clip-text text-transparent"
                          >
                            {heroLine.name}
                          </motion.span>
                        )}
                      </>
                    ) : (
                      <motion.span
                        initial={{ opacity: 0, y: 16, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                        className="block bg-gradient-to-r from-foreground to-foreground/60 bg-clip-text text-transparent"
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
              <div className="w-full max-w-2xl">
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
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.08 + i * 0.05, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                        onClick={() => usePrompt(p)}
                        className="rounded-xl border border-border bg-transparent px-3.5 py-3 text-left text-sm text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground active:scale-[0.98]"
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
      <CanvasPanel />
      <Popouts />
      <CompleteProfileModal />
      {sendError && (
        <div className="fixed bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-full border border-border bg-elevated px-4 py-2 text-sm text-danger shadow-[var(--shadow-composer)]">
          {sendError}
        </div>
      )}
    </div>
  );
}
