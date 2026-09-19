import { useEffect } from "react";
import { Building2, FolderKanban, PanelLeft, Puzzle, Search, SquarePen, Trash2, X } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { ProfileDock } from "@/components/profile-dock";
import { BrandWordmark } from "@/components/brand-mark";
import { api } from "@/lib/api";
import { filteredChats, useChat } from "@/lib/chat/store";
import { usePlan } from "@/lib/usage/planStore";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const navigate = useNavigate();
  const open = useChat((s) => s.sidebarOpen);
  const setOpen = useChat((s) => s.setSidebarOpen);
  const chats = useChat((s) => s.chats);
  const query = useChat((s) => s.query);
  const setQuery = useChat((s) => s.setQuery);
  const activeId = useChat((s) => s.activeId);
  const selectChat = useChat((s) => s.selectChat);
  const deleteChatLocal = useChat((s) => s.deleteChat);
  const newChat = useChat((s) => s.newChat);
  const setActiveProjectId = useChat((s) => s.setActiveProjectId);
  const setDialog = useChat((s) => s.setDialog);
  const isEnterprise = usePlan((s) => s.isEnterprise);
  const loadPlan = usePlan((s) => s.load);
  // Project chats are project-scoped only (see hydrateFromServer/listConversations) — the main
  // list only ever receives unscoped ones from the backend, but this also guards against any
  // stale project-tagged chat left over in localStorage from before that filter existed.
  const visible = filteredChats(
    chats.filter((c) => !c.projectId),
    query,
  );

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  function handleDelete(id: string) {
    const conversationId = chats.find((c) => c.id === id)?.conversationId;
    deleteChatLocal(id);
    if (id === activeId) void navigate({ to: "/" });
    if (conversationId) void api.delete(`/chat/conversations/${conversationId}`).catch(() => {});
  }

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-30 bg-black/50 backdrop-blur-[2px] transition-opacity duration-300 md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setOpen(false)}
      />
      <aside
        className={cn(
          "premium-panel fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-border transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] md:static md:z-0 md:w-64 md:shrink-0",
          open ? "translate-x-0" : "-translate-x-full md:hidden",
        )}
      >
        <div className="flex h-14 items-center justify-between px-3">
          <div className="flex items-center gap-2 px-1 text-foreground">
            <BrandWordmark className="text-base" />
          </div>
          <button
            type="button"
            className="flex size-9 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground md:hidden"
            aria-label="Close sidebar"
            onClick={() => setOpen(false)}
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="px-3">
          <button
            type="button"
            onClick={() => {
              setActiveProjectId(null);
              newChat();
              void navigate({ to: "/" });
              if (window.innerWidth < 768) setOpen(false);
            }}
            className="premium-control flex h-10 w-full items-center gap-2 rounded-xl px-2 text-sm font-medium text-foreground hover:bg-chip"
          >
            <SquarePen className="size-4" />
            New chat
          </button>
          <label className="mt-2 flex h-10 items-center gap-2 rounded-xl border border-border bg-composer px-2.5 text-muted">
            <Search className="size-4 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle"
            />
          </label>
        </div>

        <nav className="scroll-thin mt-3 flex-1 overflow-y-auto px-2 pb-4">
          {visible.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-subtle">
              {chats.length === 0 ? "No chats yet" : "No matches"}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {visible.map((c) => (
                <li key={c.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => {
                      selectChat(c.id);
                      if (c.conversationId) {
                        void navigate({ to: "/c/$conversationId", params: { conversationId: c.conversationId } });
                      }
                      if (window.innerWidth < 768) setOpen(false);
                    }}
                    className={cn(
                      "premium-control flex h-10 w-full items-center rounded-xl pr-9 pl-2.5 text-left text-sm",
                      c.id === activeId
                        ? "bg-chip text-foreground"
                        : "text-muted hover:bg-chip/70 hover:text-foreground",
                    )}
                  >
                    <span className="truncate">{c.title}</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete chat"
                    onClick={() => handleDelete(c.id)}
                    className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-subtle opacity-100 transition-opacity duration-150 hover:bg-elevated hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
        <div className="border-t border-border px-2 pt-2">
          <button
            type="button"
            onClick={() => {
              void navigate({ to: "/projects" });
              if (window.innerWidth < 768) setOpen(false);
            }}
            className="flex h-10 w-full items-center gap-2 rounded-xl px-2 text-sm text-muted transition-colors hover:bg-chip hover:text-foreground"
          >
            <FolderKanban className="size-4" />
            Projects
          </button>
          {isEnterprise && (
            <button
              type="button"
              onClick={() => {
                void navigate({ to: "/team" });
                if (window.innerWidth < 768) setOpen(false);
              }}
              className="flex h-10 w-full items-center gap-2 rounded-xl px-2 text-sm text-muted transition-colors hover:bg-chip hover:text-foreground"
            >
              <Building2 className="size-4" />
              Team
            </button>
          )}
          <button
            type="button"
            onClick={() => setDialog("plugins")}
            className="flex h-10 w-full items-center gap-2 rounded-xl px-2 text-sm text-muted transition-colors hover:bg-chip hover:text-foreground"
          >
            <Puzzle className="size-4" />
            Plugins
          </button>
        </div>
        <ProfileDock />
      </aside>
    </>
  );
}

export function SidebarToggle() {
  const open = useChat((s) => s.sidebarOpen);
  const setOpen = useChat((s) => s.setSidebarOpen);
  return (
    <button
      type="button"
      aria-label={open ? "Hide sidebar" : "Show sidebar"}
      onClick={() => setOpen(!open)}
      className="flex size-9 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-chip hover:text-foreground"
    >
      <PanelLeft className="size-4" />
    </button>
  );
}
