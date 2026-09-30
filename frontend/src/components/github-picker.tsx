import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, Github, Loader2, Lock, Plus, Search, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export type RepoChoice = { repo: string; branch: string };
type Repo = { fullName: string; private: boolean; defaultBranch: string; description: string | null };

/** Small dropdown shell shared by the repo and branch pickers. */
function Dropdown({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute bottom-10 left-0 z-30 w-80 overflow-hidden rounded-xl border border-border bg-elevated shadow-[var(--shadow-panel)]">{children}</div>
    </>
  );
}

const chip = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-composer px-2.5 text-xs text-foreground hover:bg-chip";

/**
 * Above the Build composer (like Claude Code's repo + branch chips): connect GitHub if it isn't,
 * otherwise pick one of your repositories (or create one), then the branch to work on (or create
 * one from the current branch). A new build then clones that repo at that branch before it starts.
 */
export function GitHubPicker({ value, onChange }: { value: RepoChoice | null; onChange: (v: RepoChoice | null) => void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoOpen, setRepoOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);

  useEffect(() => {
    api
      .get<{ accounts: { provider: string }[] }>("/connectors")
      .then((r) => setConnected(r.accounts.some((a) => a.provider === "github")))
      .catch(() => setConnected(false));
  }, []);

  async function connect() {
    setError(null);
    try {
      const { url } = await api.get<{ url: string }>(`/connectors/github/start?returnTo=${encodeURIComponent("/build")}`);
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start connecting GitHub");
    }
  }

  if (connected === null) return <div className="mb-2 h-8" />;
  if (!connected) {
    return (
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void connect()} className={chip}>
          <Github className="size-3.5" /> Connect GitHub to work on a repository
        </button>
        <span className="text-xs text-subtle">or just describe a new project below</span>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    );
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <div className="relative">
        <button type="button" onClick={() => setRepoOpen((v) => !v)} className={chip}>
          <Github className="size-3.5 text-muted" />
          {value ? value.repo : "New project · or pick a repository"}
          <ChevronDown className="size-3 text-muted" />
        </button>
        <Dropdown open={repoOpen} onClose={() => setRepoOpen(false)}>
          <RepoList
            selected={value?.repo ?? null}
            onPick={(r) => {
              onChange(r ? { repo: r.fullName, branch: r.defaultBranch } : null);
              setRepoOpen(false);
            }}
          />
        </Dropdown>
      </div>
      {value && (
        <div className="relative">
          <button type="button" onClick={() => setBranchOpen((v) => !v)} className={chip}>
            <GitBranch className="size-3.5 text-muted" /> {value.branch} <ChevronDown className="size-3 text-muted" />
          </button>
          <Dropdown open={branchOpen} onClose={() => setBranchOpen(false)}>
            <BranchList
              repo={value.repo}
              current={value.branch}
              onPick={(branch) => {
                onChange({ ...value, branch });
                setBranchOpen(false);
              }}
            />
          </Dropdown>
        </div>
      )}
      {value && (
        <button type="button" aria-label="Don't use a repository" onClick={() => onChange(null)} className="rounded-md p-1 text-subtle hover:text-foreground">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function RepoList({ selected, onPick }: { selected: string | null; onPick: (r: Repo | null) => void }) {
  const [q, setQ] = useState("");
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const t = window.setTimeout(() => {
      api
        .get<{ repositories: Repo[] }>(`/connectors/github/repos?mine=1&q=${encodeURIComponent(q)}`)
        .then((r) => {
          setRepos(r.repositories);
          setError(null);
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load your repositories"));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { repository } = await api.post<{ repository: Repo }>("/connectors/github/repos", { name: name.trim(), private: isPrivate });
      onPick(repository);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the repository");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-h-96 flex-col">
      <label className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Search className="size-3.5 text-subtle" />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your repositories" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" />
      </label>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
        <button type="button" onClick={() => onPick(null)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-chip">
          <Plus className="size-3.5 text-muted" /> New project (no repository)
        </button>
        {error && <p className="px-2.5 py-2 text-xs text-danger">{error}</p>}
        {repos === null && !error ? (
          <p className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin" /> Loading your repositories…
          </p>
        ) : (
          repos?.map((r) => (
            <button key={r.fullName} type="button" onClick={() => onPick(r)} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-chip", selected === r.fullName && "bg-chip")}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{r.fullName}</span>
                {r.description && <span className="block truncate text-xs text-muted">{r.description}</span>}
              </span>
              {r.private && <Lock className="size-3 shrink-0 text-subtle" />}
              {selected === r.fullName && <Check className="size-3.5 shrink-0" />}
            </button>
          ))
        )}
        {repos?.length === 0 && <p className="px-2.5 py-2 text-xs text-muted">No matching repositories.</p>}
      </div>
      <div className="border-t border-border p-2">
        {creating ? (
          <div className="flex flex-col gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value.replace(/[^\w.-]/g, "-"))}
              placeholder="new-repository-name"
              className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none"
            />
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> Private
              </label>
              <div className="flex gap-2">
                <button type="button" onClick={() => setCreating(false)} className="rounded-full px-3 py-1 text-xs text-muted hover:text-foreground">
                  Cancel
                </button>
                <button type="button" disabled={!name.trim() || busy} onClick={() => void create()} className="rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background disabled:opacity-40">
                  {busy ? "Creating…" : "Create"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setCreating(true)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-chip">
            <Plus className="size-3.5 text-muted" /> Create a new repository
          </button>
        )}
      </div>
    </div>
  );
}

function BranchList({ repo, current, onPick }: { repo: string; current: string; onPick: (b: string) => void }) {
  const [branches, setBranches] = useState<string[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ branches: string[] }>(`/connectors/github/branches?repo=${encodeURIComponent(repo)}`)
      .then((r) => setBranches(r.branches))
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load branches"));
  }, [repo]);

  const name = q.trim();
  const exists = branches?.includes(name);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/connectors/github/branches", { repo, branch: name, from: current });
      onPick(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the branch");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-h-80 flex-col">
      <label className="flex items-center gap-2 border-b border-border px-3 py-2">
        <GitBranch className="size-3.5 text-subtle" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find or create a branch" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" />
      </label>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
        {error && <p className="px-2.5 py-2 text-xs text-danger">{error}</p>}
        {branches === null && !error ? (
          <p className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin" /> Loading branches…
          </p>
        ) : (
          branches
            ?.filter((b) => !name || b.toLowerCase().includes(name.toLowerCase()))
            .map((b) => (
              <button key={b} type="button" onClick={() => onPick(b)} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-chip", b === current && "bg-chip")}>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{b}</span>
                {b === current && <Check className="size-3.5" />}
              </button>
            ))
        )}
      </div>
      {name && !exists && branches !== null && (
        <div className="border-t border-border p-2">
          <button type="button" disabled={busy} onClick={() => void create()} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-chip disabled:opacity-50">
            <Plus className="size-3.5 text-muted" /> {busy ? "Creating…" : <>Create branch <span className="font-mono text-xs">{name}</span> from <span className="font-mono text-xs">{current}</span></>}
          </button>
        </div>
      )}
    </div>
  );
}
