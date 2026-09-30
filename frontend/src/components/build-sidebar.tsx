import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Code2, LibraryBig, MessageSquare, Plus, Puzzle, Search, Trash2, X } from "lucide-react";
import { BrandWordmark } from "@/components/brand-mark";
import { ProfileDock } from "@/components/profile-dock";
import { api } from "@/lib/api";
import { STATUS_META, useBuildSessions } from "@/lib/build-mode/sessions";
import { filteredChats, useChat, type ServerConversation } from "@/lib/chat/store";
import { cn } from "@/lib/utils";

/** Chat ⇄ Build switch at the top of the sidebar (the two-icon toggle in Claude Code's header). */
export function WorkspaceSwitch({ active }: { active: "chat" | "build" }) {
  const navigate = useNavigate();
  const newChat = useChat((s) => s.newChat);
  const setActiveProjectId = useChat((s) => s.setActiveProjectId);
  const go = (to: "chat" | "build") => {
    if (to === active) return;
    setActiveProjectId(null);
    newChat();
    void navigate({ to: to === "build" ? "/build" : "/" });
  };
  return (
    <div className="flex items-center rounded-xl border border-border bg-composer p-0.5" role="tablist" aria-label="Workspace">
      {(
        [
          ["chat", MessageSquare, "Chat"],
          ["build", Code2, "Build"],
        ] as const
      ).map(([id, Icon, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={active === id}
          aria-label={label}
          title={label}
          onClick={() => go(id)}
          className={cn(
            "flex h-7 w-8 items-center justify-center rounded-[10px] transition-colors",
            active === id ? "bg-background text-foreground shadow-[var(--shadow-soft)]" : "text-muted hover:text-foreground",
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}

/** The Build workspace's own sidebar, laid out like Claude Code: search, New, a couple of shortcuts,
 *  then Recents — every build session with a status dot (needs input / running / done / error). */
export function BuildSidebar({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const chats = useChat((s) => s.chats);
  const query = useChat((s) => s.query);
  const setQuery = useChat((s) => s.setQuery);
  const activeId = useChat((s) => s.activeId);
  const selectChat = useChat((s) => s.selectChat);
  const deleteChatLocal = useChat((s) => s.deleteChat);
  const newChat = useChat((s) => s.newChat);
  const openPlugins = useChat((s) => s.openPlugins);
  const sessions = useBuildSessions((s) => s.sessions);
  const statusById = useMemo(() => new Map(sessions.map((x) => [x.id, x.status])), [sessions]);

  const visible = filteredChats(
    chats.filter((c) => !c.projectId && (c.workspace === "build" || c.hasBuild)),
    query,
  );
  const closeOnMobile = () => {
    if (window.innerWidth < 768) onClose();
  };

  function handleDelete(id: string) {
    const conversationId = chats.find((c) => c.id === id)?.conversationId;
    deleteChatLocal(id);
    if (id === activeId) void navigate({ to: "/build" });
    if (conversationId) {
      api
        .delete(`/chat/conversations/${conversationId}`)
        .then(() => void useBuildSessions.getState().load())
        .catch(() => {
          void api
            .get<{ conversations: ServerConversation[] }>("/chat/conversations")
            .then((res) => useChat.getState().hydrateFromServer(res.conversations))
            .catch(() => {});
          window.alert("Couldn't delete that build — check your connection and try again.");
        });
    }
  }

  return (
    <>
      <div className="flex h-14 items-center justify-between gap-2 px-3">
        <div className="flex min-w-0 items-center gap-1.5 px-1 text-foreground">
          <BrandWordmark className="text-xl" />
          <span className="text-xl font-medium text-muted">Build</span>
        </div>
        <div className="flex items-center gap-1">
          <WorkspaceSwitch active="build" />
          <button
            type="button"
            className="flex size-9 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground md:hidden"
            aria-label="Close sidebar"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div className="px-3 pb-2">
        <label className="flex h-10 items-center gap-2 rounded-xl border border-border bg-composer px-2.5 text-muted">
          <Search className="size-4 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle"
          />
        </label>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-4">
        <div className="flex flex-col gap-0.5 px-1">
          <button
            type="button"
            onClick={() => {
              newChat();
              void navigate({ to: "/build" });
              closeOnMobile();
            }}
            className={cn(
              "premium-control flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm font-semibold text-foreground hover:bg-chip-on",
              !activeId && "bg-chip-on",
            )}
          >
            <Plus className="size-4 text-muted" />
            New
          </button>
          <button
            type="button"
            onClick={() => {
              void navigate({ to: "/library" });
              closeOnMobile();
            }}
            className="premium-control flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm font-medium text-foreground hover:bg-chip-on"
          >
            <LibraryBig className="size-4 text-muted" />
            Library
          </button>
          <button
            type="button"
            onClick={() => openPlugins("connectors")}
            className="premium-control flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm font-medium text-foreground hover:bg-chip-on"
          >
            <Puzzle className="size-4 text-muted" />
            Plugins
          </button>
        </div>

        <p className="mt-5 px-3 pb-1 text-xs font-medium text-subtle">Recents</p>
        {visible.length === 0 ? (
          <p className="px-3 py-4 text-xs text-subtle">{query.trim() ? "No matches" : "No builds yet — describe an app to start one"}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {visible.map((c) => {
              const status = c.conversationId ? statusById.get(c.conversationId) : undefined;
              const meta = status ? STATUS_META[status] : null;
              return (
                <li key={c.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => {
                      selectChat(c.id);
                      if (c.conversationId) void navigate({ to: "/build/$conversationId", params: { conversationId: c.conversationId } });
                      closeOnMobile();
                    }}
                    className={cn(
                      "premium-control flex h-10 w-full items-center gap-2.5 rounded-xl pr-9 pl-3 text-left text-sm font-medium",
                      c.id === activeId ? "bg-selected text-foreground" : "text-muted hover:bg-chip-on hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn("size-1.5 shrink-0 rounded-full", meta ? meta.dot : "bg-border")}
                      title={meta?.label}
                      aria-label={meta?.label}
                    />
                    <span className="truncate">{c.title}</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete build"
                    onClick={() => handleDelete(c.id)}
                    className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-subtle opacity-100 transition-opacity duration-150 hover:bg-elevated hover:text-danger sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <ProfileDock />
    </>
  );
}
