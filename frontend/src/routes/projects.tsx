import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, MessageSquare, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { filteredChats, useChat, type ServerConversation } from "@/lib/chat/store";
import { cn } from "@/lib/utils";

export type AssistantProject = {
  id: string;
  name: string;
  mode: "personal" | "work" | "developer";
  description: string;
  instructions: string;
  repository_url: string | null;
  updated_at: string;
};

function CloseButton({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      aria-label="Close"
      onClick={() => void navigate({ to })}
      className="flex size-9 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground"
    >
      <X className="size-5" />
    </button>
  );
}

function ProjectForm({
  initial,
  busy,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  initial?: Partial<AssistantProject>;
  busy: boolean;
  submitLabel: string;
  onCancel?: () => void;
  onSubmit: (input: {
    name: string;
    mode: AssistantProject["mode"];
    description: string;
    instructions: string;
    repositoryUrl: string;
  }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [mode, setMode] = useState<AssistantProject["mode"]>(initial?.mode ?? "work");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [repositoryUrl, setRepositoryUrl] = useState(initial?.repository_url ?? "");

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-border bg-elevated p-4">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Project name"
        className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none"
      />
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as AssistantProject["mode"])}
        className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none"
      >
        <option value="work">Work project</option>
        <option value="developer">Developer project</option>
        <option value="personal">Personal project</option>
      </select>
      {mode === "developer" && (
        <input
          value={repositoryUrl}
          onChange={(e) => setRepositoryUrl(e.target.value)}
          placeholder="Repository URL"
          className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none"
        />
      )}
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Short description — what this project is for"
        className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none"
      />
      <textarea
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder="Persistent instructions, files to remember, team rules, or repo notes"
        rows={3}
        className="resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
      />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="h-9 rounded-full border border-border px-3 text-sm text-muted hover:bg-chip"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => onSubmit({ name, mode, description, instructions, repositoryUrl })}
          className="h-9 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  const [projects, setProjects] = useState<AssistantProject[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    if (!signedIn) return;
    api
      .get<{ projects: AssistantProject[] }>("/projects")
      .then((res) => {
        setProjects(res.projects);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load projects"));
  }

  useEffect(refresh, [signedIn]);

  async function createProject(input: {
    name: string;
    mode: AssistantProject["mode"];
    description: string;
    instructions: string;
    repositoryUrl: string;
  }) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ project: AssistantProject }>("/projects", input);
      setProjects((current) => [res.project, ...current]);
      setCreating(false);
      void navigate({ to: "/projects/$projectId", params: { projectId: res.project.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create project");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background px-4 py-8 text-foreground md:px-8">
      <div className="mx-auto flex max-w-3xl flex-col">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
            <p className="mt-1 text-sm text-muted">
              Persistent Work, Developer, or Personal context. Chats you start inside a project stay
              inside it — they won't clutter your main chat list.
            </p>
          </div>
          <CloseButton to="/" />
        </div>

        {!signedIn ? (
          <p className="mt-8 text-sm text-muted">Sign in to create and manage projects.</p>
        ) : (
          <>
            {error && <p className="mt-4 text-sm text-danger">{error}</p>}

            <div className="mt-6">
              {creating ? (
                <ProjectForm busy={busy} submitLabel="Create project" onCancel={() => setCreating(false)} onSubmit={createProject} />
              ) : (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border text-sm font-medium text-muted hover:bg-chip hover:text-foreground"
                >
                  <Plus className="size-4" />
                  New project
                </button>
              )}
            </div>

            <div className="mt-6 flex flex-col gap-2">
              {projects.length === 0 && !creating && (
                <p className="py-8 text-center text-sm text-subtle">No projects yet.</p>
              )}
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => void navigate({ to: "/projects/$projectId", params: { projectId: project.id } })}
                  className="flex items-center gap-3 rounded-2xl border border-border bg-elevated px-4 py-3 text-left hover:bg-chip"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{project.name}</p>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      <span className="capitalize">{project.mode}</span>
                      {project.description ? ` — ${project.description}` : ""}
                    </p>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-subtle" />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { user } = useCurrentUserState();
  const signedIn = Boolean(user && !user.isDevFallback);
  const [project, setProject] = useState<AssistantProject | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const chats = useChat((s) => s.chats);
  const selectChat = useChat((s) => s.selectChat);
  const deleteChatLocal = useChat((s) => s.deleteChat);
  const setActiveProjectId = useChat((s) => s.setActiveProjectId);
  const newChat = useChat((s) => s.newChat);
  const projectChats = filteredChats(
    chats.filter((c) => c.projectId === projectId),
    query,
  );

  function refresh() {
    if (!signedIn) return;
    api
      .get<{ projects: AssistantProject[] }>("/projects")
      .then((res) => {
        const found = res.projects.find((p) => p.id === projectId) ?? null;
        setProject(found);
        setError(found ? null : "Project not found");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load project"));
    api
      .get<{ conversations: ServerConversation[] }>(`/projects/${projectId}/conversations`)
      .then((res) => useChat.getState().hydrateFromServer(res.conversations, projectId))
      .catch(() => {});
  }

  useEffect(refresh, [signedIn, projectId]);

  async function saveEdit(input: {
    name: string;
    mode: AssistantProject["mode"];
    description: string;
    instructions: string;
    repositoryUrl: string;
  }) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.patch<{ project: AssistantProject }>(`/projects/${projectId}`, input);
      setProject(res.project);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update project");
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject() {
    if (!window.confirm(`Delete "${project?.name}"? Its chats will move to your main chat list, not be deleted.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/projects/${projectId}`);
      void navigate({ to: "/projects" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete project");
      setBusy(false);
    }
  }

  function startNewChat() {
    setActiveProjectId(projectId);
    newChat();
    void navigate({ to: "/" });
  }

  function openChat(chatId: string, conversationId?: string) {
    selectChat(chatId);
    if (conversationId) void navigate({ to: "/c/$conversationId", params: { conversationId } });
  }

  function deleteProjectChat(chatId: string, conversationId?: string) {
    deleteChatLocal(chatId);
    if (conversationId) void api.delete(`/chat/conversations/${conversationId}`).catch(() => {});
  }

  if (!signedIn) {
    return (
      <div className="min-h-dvh bg-background px-4 py-8 text-foreground md:px-8">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <p className="text-sm text-muted">Sign in to view this project.</p>
          <CloseButton to="/projects" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-background px-4 py-8 text-foreground md:px-8">
      <div className="mx-auto flex max-w-3xl flex-col">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => void navigate({ to: "/projects" })}
            className="text-sm text-muted hover:text-foreground"
          >
            ← Projects
          </button>
          <CloseButton to="/" />
        </div>

        {error && <p className="mt-4 text-sm text-danger">{error}</p>}

        {project && !editing && (
          <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-border bg-elevated p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-xl font-bold tracking-tight">{project.name}</h1>
                <p className="mt-1 text-xs capitalize text-muted">
                  {project.mode}
                  {project.repository_url ? ` — ${project.repository_url}` : ""}
                </p>
                {project.description && <p className="mt-2 text-sm text-muted">{project.description}</p>}
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  aria-label="Edit project"
                  onClick={() => setEditing(true)}
                  className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-foreground"
                >
                  <Pencil className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label="Delete project"
                  disabled={busy}
                  onClick={() => void deleteProject()}
                  className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-chip hover:text-danger"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
            {project.instructions && (
              <p className="whitespace-pre-wrap rounded-xl border border-border bg-background px-3 py-2 text-xs text-muted">
                {project.instructions}
              </p>
            )}
          </div>
        )}

        {project && editing && (
          <div className="mt-4">
            <ProjectForm
              initial={project}
              busy={busy}
              submitLabel="Save changes"
              onCancel={() => setEditing(false)}
              onSubmit={saveEdit}
            />
          </div>
        )}

        <button
          type="button"
          onClick={startNewChat}
          className="mt-5 flex h-11 items-center justify-center gap-2 rounded-full bg-primary text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          <Plus className="size-4" />
          New chat in this project
        </button>

        <label className="mt-5 flex h-10 items-center gap-2 rounded-xl border border-border bg-composer px-2.5 text-muted">
          <MessageSquare className="size-4 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this project's chats"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle"
          />
        </label>

        <div className="mt-3 flex flex-col gap-1">
          {projectChats.length === 0 && <p className="py-6 text-center text-sm text-subtle">No chats in this project yet.</p>}
          {projectChats.map((chat) => (
            <div key={chat.id} className="group relative">
              <button
                type="button"
                onClick={() => openChat(chat.id, chat.conversationId)}
                className={cn(
                  "flex h-11 w-full items-center rounded-xl pr-9 pl-3 text-left text-sm",
                  "text-muted hover:bg-chip/70 hover:text-foreground",
                )}
              >
                <span className="truncate">{chat.title}</span>
              </button>
              <button
                type="button"
                aria-label="Delete chat"
                onClick={() => deleteProjectChat(chat.id, chat.conversationId)}
                className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-subtle opacity-0 transition-opacity hover:bg-elevated hover:text-danger group-hover:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
