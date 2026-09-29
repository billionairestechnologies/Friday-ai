import { create } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
import { DEFAULT_MODEL_ID } from "./models";
import type { AgentStatus, Attachment, BuildInfo, Chat, ChatMessage, Citation } from "./types";
import { uid } from "../utils";

const TITLE_FROM = 48;

function titleFrom(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > TITLE_FROM ? `${clean.slice(0, TITLE_FROM)}…` : clean;
}

type DialogId = "settings" | "login" | "plugins" | "help" | null;

export type TurnCommit = {
  content: string;
  thinking?: string;
  citations?: Citation[];
  error?: string;
  modelLabel?: string;
  agents?: AgentStatus[];
  /** Set true when search auto-triggered server-side for this turn (Search toggle was off but the
   *  model judged it needed live info) — persists the chain-of-thought/sources display past the
   *  end of streaming, when the live-only override in overlayLive() no longer applies. */
  usedSearch?: boolean;
  /** Set true when Canvas auto-opened mid-stream for this turn (see markLiveCanvasOn) — persists
   *  the chain-of-thought canvas step log past the end of streaming, same reasoning as usedSearch
   *  above. */
  usedCanvas?: boolean;
  /** Build Mode steps + preview for this turn (see BuildInfo). */
  build?: BuildInfo;
};

export type ServerConversation = {
  id: string;
  title: string;
  updated_at: string;
  project_id?: string | null;
  workspace?: string | null;
  has_build?: boolean | null;
};

export type ServerMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  model_label?: string | null;
  thinking?: string | null;
  citations?: Citation[] | null;
  agents?: AgentStatus[] | null;
  used_think?: boolean | null;
  used_search?: boolean | null;
  used_canvas?: boolean | null;
  error?: string | null;
  build?: BuildInfo | null;
  message_attachments?: {
    id: string;
    name: string;
    mime: string;
    size_bytes: number;
    kind: "image" | "file";
    data_url: string | null;
  }[];
  created_at: string;
};

type ChatState = {
  hydrated: boolean;
  chats: Chat[];
  activeId: string | null;
  sidebarOpen: boolean;
  query: string;
  model: string;
  think: boolean;
  webSearch: boolean;
  /** Deep Research: long multi-source research turns that end in a cited report. */
  research: boolean;
  canvas: boolean;
  canvasOpen: boolean;
  settingsTab: string;
  activeProjectId: string | null;
  /** Which workspace the current page is (the Build page vs regular chat) — new chats inherit it. */
  workspace: "chat" | "build";
  appearance: "dark" | "light";
  /** Persona/behavior instruction from Settings → Behavior, sent as a system prompt with every message. */
  behavior: string;
  draft: string;
  attachments: Attachment[];
  dialog: DialogId;
  /** Selected ElevenLabs voice for Voice Mode / spoken replies. Null until the user picks one. */
  voiceId: string | null;
  voiceName: string | null;
  /** Whether the first-time voice picker has been shown, so Voice Mode only shows it once. */
  voiceIntroSeen: boolean;
  /** Which signed-in account (or null for guest) the current `chats` belong to — lets
   *  syncOwner() detect an account switch on a shared device and wipe stale chats instead of
   *  leaking one user's conversations into another user's session. */
  ownerUserId: string | null;
  setHydrated: () => void;
  setSidebarOpen: (open: boolean) => void;
  setQuery: (q: string) => void;
  setModel: (id: string) => void;
  setThink: (v: boolean) => void;
  setBehavior: (v: string) => void;
  setWebSearch: (v: boolean) => void;
  setResearch: (v: boolean) => void;
  setCanvas: (v: boolean) => void;
  setCanvasOpen: (v: boolean) => void;
  setSettingsTab: (id: string) => void;
  setActiveProjectId: (id: string | null) => void;
  setWorkspace: (workspace: "chat" | "build") => void;
  setAppearance: (v: "dark" | "light") => void;
  setVoice: (id: string, name: string) => void;
  setVoiceIntroSeen: (v: boolean) => void;
  setDraft: (v: string) => void;
  setDialog: (id: DialogId) => void;
  addAttachments: (files: Attachment[]) => void;
  removeAttachment: (id: string) => void;
  clearDraft: () => void;
  newChat: () => void;
  selectChat: (id: string) => void;
  selectConversation: (conversationId: string) => boolean;
  deleteChat: (id: string) => void;
  clearAllChats: () => void;
  /** Call whenever the authenticated identity resolves or changes (login, signup, logout,
   *  bootstrap). If it differs from the account the currently-loaded chats belong to, wipes the
   *  local chat cache so the next account never sees the previous one's conversations on a
   *  shared device. No-op when it's the same account reconnecting (e.g. a page reload). */
  syncOwner: (userId: string | null) => void;
  beginTurn: (user: ChatMessage) => { chatId: string; assistantId: string };
  commitTurn: (chatId: string, assistantId: string, data: TurnCommit) => void;
  setConversationId: (chatId: string, conversationId: string, projectId?: string, workspace?: "build") => void;
  setConversationModel: (chatId: string, model: string) => void;
  appendUserMessage: (user: ChatMessage) => { chatId: string };
  appendAssistantReplies: (chatId: string, replies: { content: string; modelLabel: string }[]) => void;
  hydrateFromServer: (conversations: ServerConversation[], projectId?: string) => void;
  loadMessagesInto: (chatId: string, messages: ServerMessage[]) => void;
};

type Persisted = Pick<
  ChatState,
  | "chats"
  | "activeId"
  | "model"
  | "think"
  | "webSearch"
  | "research"
  | "canvas"
  | "appearance"
  | "behavior"
  | "activeProjectId"
  | "sidebarOpen"
  | "voiceId"
  | "voiceName"
  | "voiceIntroSeen"
  | "ownerUserId"
>;

function createThrottledStorage(ms = 700): PersistStorage<Persisted> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { name: string; value: string } | undefined;

  const flush = () => {
    timer = undefined;
    if (!pending || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(pending.name, pending.value);
    } catch {
      /* quota */
    }
    pending = undefined;
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flush);
  }

  return {
    getItem: (name) => {
      if (typeof localStorage === "undefined") return null;
      const raw = localStorage.getItem(name);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as { state: Persisted; version?: number };
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      pending = { name, value: JSON.stringify(value) };
      if (timer == null) timer = setTimeout(flush, ms);
    },
    removeItem: (name) => {
      pending = undefined;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (typeof localStorage !== "undefined") localStorage.removeItem(name);
    },
  };
}

export const useChat = create<ChatState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      chats: [],
      activeId: null,
      sidebarOpen: true,
      query: "",
      model: DEFAULT_MODEL_ID,
      think: false,
      webSearch: false,
      research: false,
      canvas: false,
      canvasOpen: false,
      settingsTab: "account",
      activeProjectId: null,
      workspace: "chat",
      appearance: "light",
      behavior: "",
      draft: "",
      attachments: [],
      dialog: null,
      voiceId: null,
      voiceName: null,
      voiceIntroSeen: false,
      ownerUserId: null,
      setHydrated: () => set({ hydrated: true }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setWorkspace: (workspace) => set({ workspace }),
      setQuery: (query) => set({ query }),
      setModel: (model) => set({ model }),
      setThink: (think) => set({ think }),
      setBehavior: (behavior) => set({ behavior }),
      setWebSearch: (webSearch) => set({ webSearch }),
      setResearch: (research) => set({ research }),
      // On mobile the canvas panel is a fullscreen overlay (`max-md:fixed max-md:inset-0`) — if
      // arming Canvas also opened it immediately, tapping the toggle buried the composer under an
      // empty panel before the user could even type a message. Only auto-open on desktop widths,
      // where it's a harmless side panel; on mobile the panel still opens naturally once a reply
      // actually starts building (see beginTurn's `canvasOpen: canvas ? true : ...`).
      setCanvas: (canvas) =>
        set((s) => ({
          canvas,
          canvasOpen: canvas
            ? typeof window !== "undefined" && window.innerWidth < 768
              ? s.canvasOpen
              : true
            : false,
        })),
      setCanvasOpen: (canvasOpen) => set({ canvasOpen }),
      setSettingsTab: (settingsTab) => set({ settingsTab }),
      setActiveProjectId: (activeProjectId) => set({ activeProjectId }),
      setAppearance: (appearance) => set({ appearance }),
      setVoice: (voiceId, voiceName) => set({ voiceId, voiceName }),
      setVoiceIntroSeen: (voiceIntroSeen) => set({ voiceIntroSeen }),
      setDraft: (draft) => set({ draft }),
      setDialog: (dialog) => set({ dialog }),
      addAttachments: (files) =>
        set((s) => ({
          attachments: [...s.attachments, ...files].slice(0, 3),
        })),
      removeAttachment: (id) =>
        set((s) => ({
          attachments: s.attachments.filter((a) => a.id !== id),
        })),
      clearDraft: () => set({ draft: "", attachments: [] }),
      newChat: () => set({ activeId: null, draft: "", attachments: [] }),
      selectChat: (id) => set({ activeId: id, draft: "", attachments: [] }),
      selectConversation: (conversationId) => {
        const chat = get().chats.find((c) => c.conversationId === conversationId);
        if (!chat) return false;
        set({ activeId: chat.id, draft: "", attachments: [] });
        return true;
      },
      deleteChat: (id) =>
        set((s) => {
          const chats = s.chats.filter((c) => c.id !== id);
          return {
            chats,
            activeId: s.activeId === id ? (chats[0]?.id ?? null) : s.activeId,
          };
        }),
      clearAllChats: () =>
        set({ chats: [], activeId: null, draft: "", attachments: [] }),
      syncOwner: (userId) =>
        set((s) => {
          if (userId === s.ownerUserId) return {};
          return { ownerUserId: userId, chats: [], activeId: null, activeProjectId: null, draft: "", attachments: [] };
        }),
      beginTurn: (user) => {
        const { think, webSearch, canvas } = get();
        const assistant: ChatMessage = {
          id: uid(),
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          streaming: true,
          status: webSearch ? "searching" : think ? "thinking" : "working",
          usedThink: think,
          usedSearch: webSearch,
          usedCanvas: canvas,
        };
        const { activeId, chats } = get();
        const existing = chats.find((c) => c.id === activeId);
        if (existing) {
          set({
            canvasOpen: canvas ? true : get().canvasOpen,
            chats: chats.map((c) =>
              c.id === existing.id
                ? {
                    ...c,
                    updatedAt: Date.now(),
                    title:
                      c.messages.length === 0
                        ? titleFrom(user.content || user.attachments?.[0]?.name || "")
                        : c.title,
                    messages: [...c.messages, user, assistant],
                  }
                : c,
            ),
            activeId: existing.id,
          });
          return { chatId: existing.id, assistantId: assistant.id };
        }
        const chat: Chat = {
          id: uid(),
          title: titleFrom(user.content || user.attachments?.[0]?.name || ""),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [user, assistant],
          ...(get().workspace === "build" ? { workspace: "build" as const } : {}),
        };
        set({ chats: [chat, ...chats], activeId: chat.id, canvasOpen: canvas ? true : get().canvasOpen });
        return { chatId: chat.id, assistantId: assistant.id };
      },
      commitTurn: (chatId, assistantId, data) =>
        set((s) => ({
          chats: s.chats.map((c) =>
            c.id !== chatId
              ? c
              : {
                  ...c,
                  updatedAt: Date.now(),
                  // A real build (not just chat tool calls) makes this chat show up under Builds.
                  hasBuild:
                    c.hasBuild ||
                    Boolean(data.build?.previewUrl || data.build?.plan || data.build?.steps?.some((st) => st.kind === "write" || st.kind === "run" || st.kind === "start")),
                  messages: c.messages.map((m) =>
                    m.id === assistantId
                      ? {
                          ...m,
                          content: data.content,
                          thinking: data.thinking,
                          citations: data.citations,
                          error: data.error,
                          modelLabel: data.modelLabel,
                          agents: data.agents,
                          usedSearch: m.usedSearch || data.usedSearch,
                          usedCanvas: m.usedCanvas || data.usedCanvas,
                          build: data.build ?? m.build,
                          streaming: false,
                          status: null,
                        }
                      : m,
                  ),
                },
          ),
        })),
      setConversationId: (chatId, conversationId, projectId, workspace) =>
        set((s) => ({
          chats: s.chats.map((c) => (c.id === chatId ? { ...c, conversationId, projectId, ...(workspace ? { workspace } : {}) } : c)),
        })),
      setConversationModel: (chatId, model) =>
        set((s) => ({
          chats: s.chats.map((c) => (c.id === chatId ? { ...c, conversationModel: model } : c)),
        })),
      appendUserMessage: (user) => {
        const { activeId, chats } = get();
        const existing = chats.find((c) => c.id === activeId);
        if (existing) {
          set({
            chats: chats.map((c) =>
              c.id === existing.id
                ? {
                    ...c,
                    updatedAt: Date.now(),
                    title: c.messages.length === 0 ? titleFrom(user.content || "") : c.title,
                    messages: [...c.messages, user],
                  }
                : c,
            ),
            activeId: existing.id,
          });
          return { chatId: existing.id };
        }
        const chat: Chat = {
          id: uid(),
          title: titleFrom(user.content || ""),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [user],
        };
        set({ chats: [chat, ...chats], activeId: chat.id });
        return { chatId: chat.id };
      },
      appendAssistantReplies: (chatId, replies) =>
        set((s) => ({
          chats: s.chats.map((c) =>
            c.id !== chatId
              ? c
              : {
                  ...c,
                  updatedAt: Date.now(),
                  messages: [
                    ...c.messages,
                    ...replies.map(
                      (r): ChatMessage => ({
                        id: uid(),
                        role: "assistant",
                        content: r.content,
                        modelLabel: r.modelLabel,
                        createdAt: Date.now(),
                      }),
                    ),
                  ],
                },
          ),
        })),
      hydrateFromServer: (conversations, projectId) =>
        set((s) => {
          const known = new Set(s.chats.map((c) => c.conversationId).filter(Boolean));
          const additions: Chat[] = conversations
            .filter((sc) => !known.has(sc.id))
            .map((sc) => ({
              id: uid(),
              conversationId: sc.id,
              title: sc.title,
              createdAt: new Date(sc.updated_at).getTime(),
              updatedAt: new Date(sc.updated_at).getTime(),
              messages: [],
              projectId: projectId ?? sc.project_id ?? undefined,
              ...(sc.workspace === "build" ? { workspace: "build" as const } : {}),
              ...(sc.has_build ? { hasBuild: true } : {}),
            }));
          const serverIds = new Map(conversations.map((sc) => [sc.id, sc]));
          // An unscoped list below the page size is the COMPLETE set of top-level chats, so a
          // synced chat missing from it was deleted on another device — drop it here too.
          // (Never a chat that's mid-stream, still local-only, or belongs to a project.)
          const complete = !projectId && conversations.length < 50;
          const kept = s.chats.filter(
            (c) =>
              !complete ||
              !c.conversationId ||
              c.projectId ||
              serverIds.has(c.conversationId) ||
              c.messages.some((m) => m.streaming),
          );
          const retitled = kept.map((c) => {
            const sc = c.conversationId ? serverIds.get(c.conversationId) : undefined;
            if (!sc) return c;
            const title = sc.title && sc.title !== c.title ? sc.title : c.title;
            const workspace = sc.workspace === "build" ? ("build" as const) : c.workspace;
            const hasBuild = Boolean(sc.has_build) || c.hasBuild;
            return title !== c.title || workspace !== c.workspace || hasBuild !== c.hasBuild ? { ...c, title, workspace, hasBuild } : c;
          });
          if (additions.length === 0 && retitled.every((c, i) => c === kept[i]) && kept.length === s.chats.length) {
            return {};
          }
          const merged = [...retitled, ...additions].sort((a, b) => b.updatedAt - a.updatedAt);
          const activeGone = s.activeId && !merged.some((c) => c.id === s.activeId);
          return { chats: merged, ...(activeGone ? { activeId: null } : {}) };
        }),
      loadMessagesInto: (chatId, messages) =>
        set((s) => ({
          chats: s.chats.map((c) =>
            c.id !== chatId
              ? c
              : {
                  ...c,
                  messages: messages
                    .filter((m) => m.role !== "system")
                    .map((m) => ({
                      id: m.id,
                      role: m.role as "user" | "assistant",
                      content: m.content,
                      modelLabel: m.model_label ?? undefined,
                      thinking: m.thinking ?? undefined,
                      citations: m.citations ?? undefined,
                      agents: m.agents ?? undefined,
                      usedThink: Boolean(m.used_think),
                      usedSearch: Boolean(m.used_search),
                      usedCanvas: Boolean(m.used_canvas),
                      error: m.error ?? undefined,
                      build: m.build ?? undefined,
                      attachments: m.message_attachments?.map((a) => ({
                        id: a.id,
                        name: a.name,
                        mime: a.mime,
                        size: a.size_bytes,
                        kind: a.kind,
                        dataUrl: a.data_url ?? "",
                      })),
                      createdAt: new Date(m.created_at).getTime(),
                    })),
                },
          ),
        })),
    }),
    {
      name: "friday-chat-v1",
      storage: createThrottledStorage(),
      partialize: (s) => ({
        chats: s.chats.map((c) => ({
          ...c,
          messages: c.messages.map((m) => ({
            ...m,
            streaming: false,
            status: null,
            attachments: m.attachments?.map((a) =>
              (a.dataUrl?.length ?? 0) > 400_000
                ? { ...a, dataUrl: "", mime: a.mime }
                : a,
            ),
          })),
        })),
        activeId: s.activeId,
        model: s.model,
        think: s.think,
        webSearch: s.webSearch,
        research: s.research,
        canvas: s.canvas,
        appearance: s.appearance,
        behavior: s.behavior,
        activeProjectId: s.activeProjectId,
        sidebarOpen: s.sidebarOpen,
        voiceId: s.voiceId,
        voiceName: s.voiceName,
        voiceIntroSeen: s.voiceIntroSeen,
        ownerUserId: s.ownerUserId,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
      },
      // Bumped once to force everyone already sitting on the old default ("dark", never
      // explicitly chosen) onto the new default ("light"). Anyone who picked a theme
      // deliberately after this ships will have it persist normally going forward — this
      // migration only overrides what a prior *default* left behind, not a real user choice
      // made post-migration.
      version: 1,
      migrate: (persisted, version) => {
        const state = persisted as Persisted;
        if (version < 1) state.appearance = "light";
        return state;
      },
    },
  ),
);

export function filteredChats(chats: Chat[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return chats;
  return chats.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      c.messages.some((m) => m.content.toLowerCase().includes(q)),
  );
}
