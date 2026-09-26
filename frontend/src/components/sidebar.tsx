import { useEffect, useState } from "react";
import {
  Building2,
  ChevronDown,
  FolderKanban,
  LibraryBig,
  MessageSquare,
  PanelLeft,
  Plus,
  Puzzle,
  Search,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { ProfileDock } from "@/components/profile-dock";
import { BrandWordmark } from "@/components/brand-mark";
import { api } from "@/lib/api";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { filteredChats, useChat, type ServerConversation } from "@/lib/chat/store";
import { usePlan } from "@/lib/usage/planStore";
import type { AssistantProject } from "@/routes/projects";
import { cn } from "@/lib/utils";

type SearchHit = { conversationId: string; title: string; messageId: string; role: string; snippet: string; createdAt: string };

/** Top-level nav rows above Projects/Chats — Chat is the only one with a real destination today;
 *  Library/Automations are placeholder pages (see routes/library.tsx, routes/automations.tsx)
 *  until those features actually exist, per explicit product decision. */
function NavRow({ icon: Icon, label, onClick }: { icon: typeof MessageSquare; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="premium-control flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm font-semibold text-foreground hover:bg-chip-on"
    >
      <Icon className="size-4 text-muted" />
      {label}
    </button>
  );
}

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
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);

  const [searchOpen, setSearchOpen] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [projects, setProjects] = useState<AssistantProject[]>([]);

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

  // Full-text search across every message on the server (not just chats loaded in this browser).
  useEffect(() => {
    const q = query.trim();
    if (!signedIn || !searchOpen || q.length < 2) {
      setHits([]);
      return;
    }
    const timer = window.setTimeout(() => {
      api
        .get<{ results: SearchHit[] }>(`/chat/search?q=${encodeURIComponent(q)}`)
        .then((res) => setHits(res.results))
        .catch(() => setHits([]));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, signedIn, searchOpen]);

  useEffect(() => {
    if (!signedIn) return;
    api
      .get<{ projects: AssistantProject[] }>("/projects")
      .then((res) => setProjects(res.projects))
      .catch(() => {});
  }, [signedIn]);

  function handleDelete(id: string) {
    const conversationId = chats.find((c) => c.id === id)?.conversationId;
    deleteChatLocal(id);
    if (id === activeId) void navigate({ to: "/" });
    if (conversationId) {
      api.delete(`/chat/conversations/${conversationId}`).catch(() => {
        // The delete didn't reach the server, so the chat would silently come back on the next
        // sync — refetch now so it visibly returns instead of looking deleted but not being.
        void api
          .get<{ conversations: ServerConversation[] }>("/chat/conversations")
          .then((res) => useChat.getState().hydrateFromServer(res.conversations))
          .catch(() => {});
        window.alert("Couldn't delete that chat — check your connection and try again.");
      });
    }
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
          // Matches the main panel's own background exactly (was --color-surface, a pale
          // blue-gray distinctly different from the white main content — that mismatch was
          // the "sidebar color doesn't match" complaint). A single hairline border-right is
          // now the only seam between sidebar and dashboard, same as Gemini's own layout.
          "bg-background fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-border transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] md:static md:z-0 md:w-64 md:shrink-0",
          open ? "translate-x-0" : "-translate-x-full md:hidden",
        )}
      >
        <div className="flex h-14 items-center justify-between px-3">
          <div className="flex items-center gap-2 px-1 text-foreground">
            <BrandWordmark className="text-xl" />
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={searchOpen ? "Close search" : "Search chats"}
              onClick={() => setSearchOpen((v) => !v)}
              className={cn(
                "flex size-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-chip hover:text-foreground",
                searchOpen && "bg-chip text-foreground",
              )}
            >
              <Search className="size-4" />
            </button>
            <button
              type="button"
              className="flex size-9 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground md:hidden"
              aria-label="Close sidebar"
              onClick={() => setOpen(false)}
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {searchOpen && (
          <div className="px-3 pb-2">
            <label className="flex h-10 items-center gap-2 rounded-xl border border-border bg-composer px-2.5 text-muted">
              <Search className="size-4 shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chats"
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle"
              />
            </label>
          </div>
        )}

        <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-4">
          {searchOpen && hits.length > 0 && (
            <div className="mb-3 px-1">
              <p className="px-1.5 pb-1 text-xs font-semibold text-subtle">In messages</p>
              <ul className="flex flex-col gap-0.5">
                {hits.map((h) => (
                  <li key={h.messageId}>
                    <button
                      type="button"
                      onClick={() => {
                        const local = chats.find((c) => c.conversationId === h.conversationId);
                        if (local) selectChat(local.id);
                        void navigate({ to: "/c/$conversationId", params: { conversationId: h.conversationId } });
                        if (window.innerWidth < 768) setOpen(false);
                      }}
                      className="premium-control flex w-full flex-col rounded-xl px-2.5 py-1.5 text-left hover:bg-chip-on"
                    >
                      <span className="truncate text-sm font-medium text-foreground">{h.title}</span>
                      <span className="line-clamp-2 text-xs text-muted">{h.snippet}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* Top-level nav: Chat is a real destination (new chat); Library/Automations are
              placeholder pages until those are real features — see NavRow's note above. */}
          <div className="flex flex-col gap-0.5 px-1 pt-1">
            <NavRow
              icon={MessageSquare}
              label="Chat"
              onClick={() => {
                setActiveProjectId(null);
                newChat();
                void navigate({ to: "/" });
                if (window.innerWidth < 768) setOpen(false);
              }}
            />
            <NavRow
              icon={LibraryBig}
              label="Library"
              onClick={() => {
                void navigate({ to: "/library" });
                if (window.innerWidth < 768) setOpen(false);
              }}
            />
            <NavRow
              icon={Workflow}
              label="Automations"
              onClick={() => {
                void navigate({ to: "/automations" });
                if (window.innerWidth < 768) setOpen(false);
              }}
            />
          </div>

          {/* Projects — a real, collapsible section listing actual projects inline (not just a
              link out to /projects), matching the requested reference layout. */}
          <div className="mt-4">
            <div className="flex h-8 items-center gap-1 px-1.5">
              <button
                type="button"
                onClick={() => setProjectsOpen((v) => !v)}
                className="flex h-7 flex-1 items-center gap-1.5 rounded-lg px-1 text-xs font-semibold text-subtle hover:bg-chip-on hover:text-foreground"
              >
                <ChevronDown className={cn("size-3.5 transition-transform", !projectsOpen && "-rotate-90")} />
                Projects
              </button>
              <button
                type="button"
                aria-label="New project"
                onClick={() => {
                  void navigate({ to: "/projects" });
                  if (window.innerWidth < 768) setOpen(false);
                }}
                className="flex size-6 items-center justify-center rounded-md text-subtle hover:bg-chip-on hover:text-foreground"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
            {projectsOpen && (
              <ul className="flex flex-col gap-0.5 px-1">
                {projects.length === 0 ? (
                  <li className="px-2.5 py-1.5 text-xs text-subtle">No projects yet</li>
                ) : (
                  projects.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => {
                          void navigate({ to: "/projects/$projectId", params: { projectId: p.id } });
                          if (window.innerWidth < 768) setOpen(false);
                        }}
                        className="premium-control flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm font-medium text-muted hover:bg-chip-on hover:text-foreground"
                      >
                        <FolderKanban className="size-3.5 shrink-0" />
                        <span className="truncate">{p.name}</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>

          {/* Chats */}
          <div className="mt-4">
            <p className="px-2.5 py-1 text-xs font-medium text-subtle">Chats</p>
            <nav>
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
                          "premium-control flex h-10 w-full items-center rounded-xl pr-9 pl-2.5 text-left text-sm font-medium",
                          c.id === activeId
                            ? "bg-selected text-foreground"
                            : "text-muted hover:bg-chip-on hover:text-foreground",
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
          </div>
        </div>
        <div className="border-t border-border px-2 pt-2">
          {isEnterprise && (
            <button
              type="button"
              onClick={() => {
                void navigate({ to: "/team" });
                if (window.innerWidth < 768) setOpen(false);
              }}
              className="flex h-10 w-full items-center gap-2 rounded-xl px-2 text-sm font-medium text-muted transition-colors hover:bg-chip-on hover:text-foreground"
            >
              <Building2 className="size-4" />
              Team
            </button>
          )}
          <button
            type="button"
            onClick={() => setDialog("plugins")}
            className="flex h-10 w-full items-center gap-2 rounded-xl px-2 text-sm font-medium text-muted transition-colors hover:bg-chip-on hover:text-foreground"
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
