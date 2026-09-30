import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, ExternalLink, GitBranch, GitPullRequest, Github, Gauge, Hammer, X } from "lucide-react";
import { STATUS_META, relativeTime, useBuildSessions, type BuildSession } from "@/lib/build-mode/sessions";
import { EFFORT_OPTIONS, useBuildPrefs } from "@/lib/build-mode/prefs";
import { useChat } from "@/lib/chat/store";
import { cn } from "@/lib/utils";

const GITHUB_REPO = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$|^([\w.-]+)\/([\w.-]+)$/i;

/** "owner/repo" from a pasted GitHub URL or a bare owner/repo, or null. */
export function parseRepo(input: string): string | null {
  const m = input.trim().match(GITHUB_REPO);
  if (!m) return null;
  const owner = m[1] ?? m[3];
  const repo = m[2] ?? m[4];
  return owner && repo ? `${owner}/${repo}` : null;
}

/** Row in the Sessions list — status, title, what it's doing/waiting on, repo, age (Claude Code's layout). */
function SessionRow({ s, onOpen }: { s: BuildSession; onOpen: () => void }) {
  const meta = STATUS_META[s.status];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="premium-control flex w-full items-center gap-3 rounded-xl bg-chip/60 px-4 py-3 text-left text-sm hover:bg-chip"
    >
      <span className={cn("flex shrink-0 items-center gap-1.5 text-xs font-medium", meta.text)}>
        <span className={cn("size-1.5 rounded-full", meta.dot)} />
        {meta.label}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{s.title}</span>
        <span className="ml-2 text-muted">{s.activity}</span>
      </span>
      {s.repo && <span className="hidden max-w-[12rem] shrink-0 truncate text-xs text-subtle md:inline">{s.repo}</span>}
      <span className="shrink-0 text-xs text-subtle tabular-nums">{relativeTime(s.updatedAt)}</span>
      <ChevronRight className="size-4 shrink-0 text-subtle" />
    </button>
  );
}

/** Build workspace home (/build with nothing open): welcome, Sessions with live status, Pull requests. */
export function BuildHome({ firstName }: { firstName?: string }) {
  const navigate = useNavigate();
  const sessions = useBuildSessions((s) => s.sessions);
  const loaded = useBuildSessions((s) => s.loaded);
  const error = useBuildSessions((s) => s.error);
  const [showAll, setShowAll] = useState(false);
  const chats = useChat((s) => s.chats);
  const prs = sessions.filter((s) => s.prUrl);
  // Sessions that need the user float to the top, then running, then the rest by recency.
  const ordered = [...sessions].sort((a, b) => {
    const rank = (x: BuildSession) => (x.status === "needs_input" ? 0 : x.status === "running" ? 1 : 2);
    return rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt);
  });
  const shown = showAll ? ordered : ordered.slice(0, 3);

  const open = (id: string) => {
    const local = chats.find((c) => c.conversationId === id);
    if (local) useChat.getState().selectChat(local.id);
    void navigate({ to: "/build/$conversationId", params: { conversationId: id } });
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-10 pb-6 md:pt-16">
      <h1 className="flex items-center gap-3 text-2xl font-medium tracking-tight text-foreground md:text-3xl">
        <span className="flex size-9 items-center justify-center rounded-xl border border-border bg-composer">
          <Hammer className="size-4" />
        </span>
        {firstName ? `Welcome back, ${firstName}` : "Welcome to Build"}
      </h1>

      <section className="mt-10">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">Sessions</h2>
          {ordered.length > 3 && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="text-xs text-muted hover:text-foreground">
              {showAll ? "Show less" : `Show ${ordered.length - 3} more`}
            </button>
          )}
        </div>
        {error ? (
          <p className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>
        ) : !loaded ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-xl bg-chip/60" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <p className="rounded-xl bg-chip/60 px-4 py-6 text-center text-sm text-muted">
            No builds yet. Describe an app below — Friday plans it with you, then builds, runs and previews it.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {shown.map((s) => (
              <SessionRow key={s.id} s={s} onOpen={() => open(s.id)} />
            ))}
          </div>
        )}
      </section>

      {prs.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-2 text-sm font-medium text-foreground">Pull requests</h2>
          <div className="flex flex-col gap-2">
            {prs.map((s) => (
              <a
                key={s.id}
                href={s.prUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className="premium-control flex items-center gap-3 rounded-xl bg-chip/60 px-4 py-3 text-sm hover:bg-chip"
              >
                <GitPullRequest className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{s.title}</span>
                {s.repo && <span className="hidden max-w-[12rem] shrink-0 truncate text-xs text-subtle md:inline">{s.repo}</span>}
                <span className="shrink-0 text-xs text-subtle">{relativeTime(s.updatedAt)}</span>
                <ExternalLink className="size-3.5 shrink-0 text-subtle" />
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Chips above the Build composer (Claude Code's environment/repo/branch row): which GitHub repo a
 *  new build works on. Only on a brand-new build — an existing session already has its project. */
export function BuildRepoChip({ repo, onChange }: { repo: string | null; onChange: (repo: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    if (!value.trim()) return setEditing(false);
    const parsed = parseRepo(value);
    if (!parsed) return setInvalid(true);
    onChange(parsed);
    setEditing(false);
    setValue("");
  };

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      {repo ? (
        <>
          <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-composer px-2.5 text-xs text-foreground">
            <Github className="size-3.5 text-muted" /> {repo}
            <button type="button" aria-label="Remove repository" onClick={() => onChange(null)} className="ml-0.5 rounded text-subtle hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </span>
          <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-composer px-2.5 text-xs text-muted">
            <GitBranch className="size-3.5" /> default branch
          </span>
        </>
      ) : editing ? (
        <label className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg border bg-composer px-2.5 text-xs", invalid ? "border-danger" : "border-border")}>
          <Github className="size-3.5 text-muted" />
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={commit}
            placeholder="owner/repo or GitHub URL"
            className="w-52 bg-transparent text-foreground outline-none placeholder:text-subtle"
          />
        </label>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-composer px-2.5 text-xs text-muted hover:text-foreground"
        >
          <Github className="size-3.5" /> New project · or import a GitHub repo
        </button>
      )}
      {invalid && <span className="text-xs text-danger">Use owner/repo or a github.com link</span>}
    </div>
  );
}

/** Under the Build composer: effort picker (the model picker lives in the composer itself). */
export function BuildComposerFooter() {
  const effort = useBuildPrefs((s) => s.effort);
  const setEffort = useBuildPrefs((s) => s.setEffort);
  const [open, setOpen] = useState(false);
  const current = EFFORT_OPTIONS.find((o) => o.id === effort)!;
  return (
    <div className="relative flex items-center justify-end gap-2 pt-1.5 text-xs text-muted">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex h-7 items-center gap-1 rounded-lg px-2 hover:bg-chip hover:text-foreground"
      >
        <Gauge className="size-3.5" /> {current.label} effort <ChevronDown className="size-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <ul role="listbox" className="absolute right-0 bottom-9 z-30 w-60 rounded-xl border border-border bg-elevated p-1 shadow-[var(--shadow-panel)]">
            {EFFORT_OPTIONS.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.id === effort}
                  onClick={() => {
                    setEffort(o.id);
                    setOpen(false);
                  }}
                  className={cn("flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-chip", o.id === effort && "bg-chip")}
                >
                  <span className="text-sm text-foreground">{o.label}</span>
                  <span className="text-xs text-muted">{o.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
