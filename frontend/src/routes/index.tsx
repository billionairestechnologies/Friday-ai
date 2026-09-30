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
import { addLiveFile, applyLive, applyLiveStep, clearLive, markLiveCanvasOn, peekLive, setLiveBuildMeta, setLivePlan, setLivePreview, setLiveSuggestBuild, startLive, upsertLiveApproval, useLiveStream } from "@/lib/chat/live-stream";
import { beginStream, endStream, isStreamActive, stopStream } from "@/lib/chat/active-streams";
import { AUTO_MODEL_ID, TEAMUP_MODEL_ID, decodeModelId, useModels } from "@/lib/chat/models";
import { createStreamBatcher } from "@/lib/chat/raf-batch";
import { streamMessage } from "@/lib/chat/stream";
import { useChat, type ServerConversation, type ServerMessage } from "@/lib/chat/store";
import { extractArtifact } from "@/lib/chat/artifact";
import type { AskQuestion, ChatMessage } from "@/lib/chat/types";
import { AskPanel, ASK_MARKER } from "@/components/ask-panel";
import { PlanApprovalPanel, PLAN_APPROVE_TEXT, PLAN_MARKER } from "@/components/plan-approval";
import { takeBuildHandoff } from "@/lib/chat/build-handoff";
import { BuildComposerFooter, BuildHome, BuildRepoChip } from "@/components/build-home";
import { useBuildSessions, useBuildSessionsSync } from "@/lib/build-mode/sessions";
import { ApprovalPanel } from "@/components/build-approval";
import type { BuildApproval } from "@/lib/chat/types";
import { useBuildPrefs } from "@/lib/build-mode/prefs";
import { fileToAttachment } from "@/lib/chat/files";
import { uid } from "@/lib/utils";
import { useQueue } from "@/lib/chat/queue";
import { Hammer, X } from "lucide-react";
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

const BUILD_PROMPTS = [
  "Build a SaaS landing page with pricing and a waitlist form",
  "Create a Kanban board app with drag and drop",
  "Build a REST API for a todo app with Express and tests",
  "Fix the failing tests in github.com/owner/repo and open a PR",
];

function modeForModel(model: string): ConversationMode {
  if (model === AUTO_MODEL_ID) return "auto";
  if (model === TEAMUP_MODEL_ID) return "teamup";
  return "single";
}

export function Home({ conversationId, workspace = "chat" }: { conversationId?: string; workspace?: "chat" | "build" } = {}) {
  const buildMode = workspace === "build";
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
  // Build plan round: the newest message is a plan waiting for approve / request changes.
  const pendingPlan = useMemo(() => {
    const last = lastAssistantMessage;
    return last && !last.streaming && last.build?.plan?.status === "pending" ? last : null;
  }, [lastAssistantMessage]);
  const queued = useQueue((s) => (activeId ? s.byChat[activeId] : undefined)) ?? [];
  // Build home: the GitHub repo a brand-new build should work on (the chip above the composer).
  const [buildRepo, setBuildRepo] = useState<string | null>(null);
  // Build sessions list (home + sidebar statuses) — refreshed whenever a turn starts or ends.
  useBuildSessionsSync(buildMode && Boolean(user) && !isPending, streaming);

  // Permission prompts (Build): from this tab's live stream, or — when the build was started on another
  // device / before a reload — polled from the server while that session is running or waiting.
  const live = useLiveStream(activeId);
  const liveApproval = live?.approvals?.filter((a) => a.state === "pending").at(-1) ?? null;
  const activeConversationId = useChat((s) => s.chats.find((c) => c.id === s.activeId)?.conversationId);
  const sessionStatus = useBuildSessions((s) => s.sessions.find((x) => x.id === activeConversationId)?.status);
  const [remoteApprovals, setRemoteApprovals] = useState<BuildApproval[]>([]);
  useEffect(() => {
    setRemoteApprovals([]);
    if (!buildMode || !activeConversationId || live || (sessionStatus !== "running" && sessionStatus !== "needs_input")) return;
    let cancelled = false;
    const load = () =>
      api
        .get<{ approvals: Omit<BuildApproval, "state">[] }>(`/build/${activeConversationId}/approvals`)
        .then((res) => !cancelled && setRemoteApprovals(res.approvals.map((a) => ({ ...a, state: "pending" as const }))))
        .catch(() => {});
    void load();
    const id = window.setInterval(load, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [buildMode, activeConversationId, live, sessionStatus]);
  const pendingApproval = liveApproval ?? remoteApprovals[0] ?? null;
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

  // Entering a workspace: new chats inherit it, and a chat from the other workspace doesn't stay
  // open (the Build page starts a fresh build session; the chat page leaves a build session).
  useEffect(() => {
    const s = useChat.getState();
    s.setWorkspace(workspace);
    if (conversationId) return;
    const active = s.chats.find((c) => c.id === s.activeId);
    if (active && (active.workspace === "build") !== buildMode) s.newChat();
  }, [workspace, buildMode, conversationId]);

  // "Open in Build" from a normal chat: the workspace starts a fresh build session with that request.
  // Sending it only starts the question/plan round — nothing is built until the plan is approved.
  useEffect(() => {
    if (!buildMode || conversationId || !available || isPending || !user) return;
    const prompt = takeBuildHandoff();
    if (prompt) void send(prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildMode, conversationId, available, isPending, user]);

  // The Build workspace docks the project panel (preview / files / terminal) on the right as soon as
  // there is something to show — on desktop only; on mobile it's a full-screen overlay the user opens.
  const activeHasBuild = useChat((s) => {
    const chat = s.chats.find((c) => c.id === s.activeId);
    return Boolean(chat?.hasBuild || chat?.messages.some((m) => m.build?.steps.length || m.build?.previewUrl));
  });
  useEffect(() => {
    if (!buildMode || window.innerWidth < 1024) return;
    if (activeHasBuild || streaming) useChat.getState().setCanvasOpen(true);
  }, [buildMode, activeHasBuild, streaming, activeId]);

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
        if (buildMode) void navigate({ to: "/build/$conversationId", params: { conversationId: chat.conversationId } });
        else void navigate({ to: "/c/$conversationId", params: { conversationId: chat.conversationId } });
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

    const body: { mode: ConversationMode; providerSlug?: string; modelId?: string; projectId?: string; workspace?: "build" } = { mode };
    if (s.activeProjectId && !buildMode) body.projectId = s.activeProjectId;
    if (buildMode) body.workspace = "build";
    if (mode === "single") {
      const decoded = decodeModelId(model);
      if (!decoded) throw new Error("Pick a model first");
      body.providerSlug = decoded.providerSlug;
      body.modelId = decoded.modelId;
    }
    const res = await api.post<{ conversation: { id: string } }>("/chat/conversations", body);
    useChat.getState().setConversationId(chatId, res.conversation.id, buildMode ? undefined : (s.activeProjectId ?? undefined), buildMode ? "build" : undefined);
    useChat.getState().setConversationModel(chatId, model);
    if (buildMode) void navigate({ to: "/build/$conversationId", params: { conversationId: res.conversation.id } });
    else void navigate({ to: "/c/$conversationId", params: { conversationId: res.conversation.id } });
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
    // A new build started from the home screen with a repo chip: say which repo, the way the backend
    // recognises it ("work on github.com/owner/repo") — it clones it before the agent starts.
    let content = trimmed;
    if (buildMode && buildRepo && !s.chats.find((c) => c.id === s.activeId)?.conversationId && !/github\.com\//i.test(trimmed)) {
      content = `Work on https://github.com/${buildRepo} — ${trimmed}`;
      setBuildRepo(null);
    }

    const user: ChatMessage = {
      id: uid(),
      role: "user",
      content,
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
      await streamMessage(conversationId, content, "text", s.think, s.behavior, s.webSearch, s.canvas, sendableAttachments, (ev) => {
        if (ev.t === "status" && ev.s === "building") applyLive(chatId, { text: "", think: "", cites: [], agents: [], status: "building" });
        else if (ev.t === "status") batch.status(ev.s);
        else if (ev.t === "think") batch.think(ev.c);
        else if (ev.t === "text") {
          batch.text(ev.c);
          maybeAutoOpenCanvas(ev.c);
        }
        else if (ev.t === "cite") batch.cite({ url: ev.u, title: ev.title });
        else if (ev.t === "file") addLiveFile(chatId, ev.file);
        else if (ev.t === "agent") batch.agent({ slug: ev.slug, model: ev.model, state: ev.state, error: ev.error });
        else if (ev.t === "step") {
          const { t: _t, ...step } = ev;
          applyLiveStep(chatId, step);
        }
        else if (ev.t === "ask") askQuestions = ev.questions;
        else if (ev.t === "plan") setLivePlan(chatId, { architecture: ev.architecture, items: ev.items, summary: ev.summary, status: ev.status });
        else if (ev.t === "suggest_build") setLiveSuggestBuild(chatId, ev.prompt);
        else if (ev.t === "approval") {
          const { t: _t, ...approval } = ev;
          upsertLiveApproval(chatId, approval);
        }
        else if (ev.t === "build") setLiveBuildMeta(chatId, { elapsedMs: ev.elapsedMs, zipBytes: ev.zipBytes, zipName: ev.zipName, prUrl: ev.prUrl });
        else if (ev.t === "preview") {
          setLivePreview(chatId, ev.url, ev.port);
          // Build Mode produced a running app — open the panel on it, same as an auto-opened artifact.
          useChat.getState().setCanvasOpen(true);
        } else if (ev.t === "err") batch.error(ev.c);
      }, ac.signal, {
        research: s.research,
        ...(s.activeSkill ? { skillId: s.activeSkill.id } : {}),
        ...(buildMode ? { effort: useBuildPrefs.getState().effort, permissionMode: useBuildPrefs.getState().permissionMode } : {}),
      });
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
      // Let already-received text finish typing out smoothly (bounded) unless the user hit Stop.
      if (ac.signal.aborted) batch.flush();
      else await batch.drain();
      const live = peekLive(chatId);
      useChat.getState().commitTurn(chatId, assistantId, {
        content: live?.text || (askQuestions ? ASK_MARKER : live?.plan?.status === "pending" ? PLAN_MARKER : ""),
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
        files: live?.files,
        build: askQuestions
          ? { steps: [], ask: askQuestions }
          : live && (live.steps.length || live.preview || live.plan)
          ? { plan: live.plan, steps: live.steps, previewUrl: live.preview?.url, port: live.preview?.port, ...live.meta }
          : live?.suggestBuild
          ? { steps: [], suggestBuild: live.suggestBuild }
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

  function approvePlan() {
    if (!pendingPlan || !activeId) return;
    // The server marks it approved too (plan.ts); mirror it so the card's badge updates right away.
    const id = pendingPlan.id;
    useChat.setState((st) => ({
      chats: st.chats.map((c) =>
        c.id !== activeId
          ? c
          : { ...c, messages: c.messages.map((m) => (m.id === id && m.build?.plan ? { ...m, build: { ...m.build, plan: { ...m.build.plan, status: "approved" as const } } } : m)) },
      ),
    }));
    void send(PLAN_APPROVE_TEXT);
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
          {buildMode && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-chip px-2.5 py-1 text-xs font-medium text-foreground">
              <Hammer className="size-3" /> Build
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-sm text-muted">{buildMode && empty ? "New build" : title}</span>
          <HeaderActions />
        </header>
        {syncError && (
          <div className="mx-4 mb-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger md:mx-6">
            {syncError}
          </div>
        )}

        <AnimatePresence mode="wait" initial={false}>
          {empty && buildMode && available ? (
            // Build home, laid out like Claude Code: welcome + Sessions + Pull requests scrolling
            // above, the composer (repo chip · input · effort) pinned at the bottom.
            <motion.div
              key="build-home"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
                <BuildHome firstName={firstName} />
              </div>
              <div className="shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">
                <div className="mx-auto w-full max-w-3xl">
                  <BuildRepoChip repo={buildRepo} onChange={setBuildRepo} />
                  <Composer
                    onSend={(message, files) => void send(message, files)}
                    onStop={stop}
                    streaming={streaming}
                    disabled={!available}
                    placeholder="Describe what to build, or what to change in the repo…"
                  />
                  <BuildComposerFooter />
                </div>
              </div>
            </motion.div>
          ) : empty ? (
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
                {available && buildMode ? (
                  <>
                    <motion.span
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.4, ease: [0.2, 0, 0, 1] }}
                      className="mb-5 flex size-12 items-center justify-center rounded-2xl border border-border bg-composer shadow-[var(--shadow-soft)]"
                    >
                      <Hammer className="size-5" />
                    </motion.span>
                    <motion.h1
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.56, ease: [0.2, 0, 0, 1] }}
                      className="text-balance text-4xl font-medium tracking-tight text-foreground sm:text-5xl"
                    >
                      What should we build?
                    </motion.h1>
                    <motion.p
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.56, delay: 0.08, ease: [0.2, 0, 0, 1] }}
                      className="mt-3 max-w-lg text-pretty text-sm text-muted"
                    >
                      Friday plans it, writes the code, runs it in a real sandbox, tests it and fixes what breaks — you
                      watch every file and command live, then preview, download or open a pull request.
                    </motion.p>
                  </>
                ) : available ? (
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
                    {(buildMode ? BUILD_PROMPTS : PROMPTS).map((p, i) => (
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
                  {pendingApproval && activeConversationId && (
                    <ApprovalPanel
                      key={pendingApproval.id}
                      approval={pendingApproval}
                      conversationId={activeConversationId}
                      onDecided={(id) => setRemoteApprovals((list) => list.filter((a) => a.id !== id))}
                    />
                  )}
                  {pendingPlan && !streaming && (
                    <PlanApprovalPanel
                      onApprove={approvePlan}
                      onRequestChanges={() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus()}
                    />
                  )}
                  <Composer
                    onSend={(message, files) => void send(message, files)}
                    onStop={stop}
                    streaming={streaming}
                    disabled={!available}
                    placeholder={pendingPlan ? "Tell me what to change in the plan…" : buildMode ? "Ask for a change, or reply to Friday…" : undefined}
                  />
                  {buildMode ? (
                    <BuildComposerFooter />
                  ) : (
                    <p className="pt-2 pb-1 text-center text-xs text-subtle">
                      Friday can be wrong. Check anything important.
                    </p>
                  )}
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
