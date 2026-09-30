import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Download,
  Eye,
  FileArchive,
  FileCode2,
  FilePen,
  GitPullRequest,
  Globe,
  Hammer,
  Lightbulb,
  ListChecks,
  Play,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { BuildInfo, BuildStep } from "@/lib/chat/types";
import { useChat } from "@/lib/chat/store";
import { downloadProjectZip } from "@/components/build-preview";

// ---------------------------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------------------------

function formatDuration(totalSeconds: number) {
  const s = Math.max(0, Math.round(totalSeconds));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function formatMs(ms: number) {
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms / 1000);
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(2)} KB`;
}

/** Live "12s" for a running step (from its server start time), or its final duration. */
function StepTime({ step }: { step: BuildStep }) {
  const [now, setNow] = useState(() => Date.now());
  const running = step.state === "running" && step.startedAt != null;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  if (running) return <span className="shrink-0 text-xs text-subtle tabular-nums">{formatDuration((now - step.startedAt!) / 1000)}</span>;
  if (step.ms != null && step.ms >= 300) return <span className="shrink-0 text-xs text-subtle tabular-nums">{formatMs(step.ms)}</span>;
  return null;
}

function stepIcon(step: BuildStep) {
  if (step.kind === "tool") return /^Searched/i.test(step.label) ? Search : /^Read /i.test(step.label) ? Globe : Wrench;
  if (step.kind === "write") return FilePen;
  if (step.kind === "read") return /^Checking|browser/i.test(step.label) ? Eye : FileCode2;
  if (step.kind === "start") return Play;
  return /browser/i.test(step.label) ? Eye : Terminal;
}

function StepIcon({ step }: { step: BuildStep }) {
  if (step.state === "running") return <span className="build-orb" aria-hidden />;
  if (step.state === "error") return <AlertCircle className="size-3.5 text-danger" />;
  const Icon = stepIcon(step);
  return <Icon className="size-3.5 text-muted" />;
}

function verb(step: BuildStep): string {
  if (step.kind === "run") return step.state === "running" ? "Running" : "Ran";
  if (step.kind === "start") return step.state === "running" ? "Starting server" : "Started server";
  return "";
}

/** Collapsible body with a smooth height transition (grid-rows 0fr → 1fr — no layout measuring). */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Mini terminal — a command, its live output, and how it ended
// ---------------------------------------------------------------------------------------------

const MiniTerminal = memo(function MiniTerminal({ step }: { step: BuildStep }) {
  const body = useRef<HTMLPreElement>(null);
  const running = step.state === "running";
  const output = step.output ?? (step.state !== "running" ? step.detail : undefined) ?? "";
  // Follow the newest output while the command runs, like a real terminal.
  useLayoutEffect(() => {
    if (running && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [output, running]);
  return (
    <div className="build-terminal mt-1 mb-2 overflow-hidden rounded-xl border border-white/[0.07] bg-[#0c0c0d] shadow-[0_2px_12px_rgba(0,0,0,0.25)]">
      <div className="flex items-center gap-1.5 border-b border-white/[0.05] px-3 py-1.5">
        <span className="size-2 rounded-full bg-[#ff5f57]/70" />
        <span className="size-2 rounded-full bg-[#febc2e]/70" />
        <span className="size-2 rounded-full bg-[#28c840]/70" />
        <span className="ml-2 font-mono text-[10.5px] text-[#6b7078]">{step.kind === "start" ? "server" : "bash"}</span>
        <span className="flex-1" />
        {!running && step.exitCode != null && (
          <span className={cn("font-mono text-[10.5px]", step.exitCode === 0 ? "text-emerald-400/80" : "text-red-400")}>exit {step.exitCode}</span>
        )}
      </div>
      <pre ref={body} className="max-h-56 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap text-[#c9ccd1]">
        <span className="text-emerald-400">$ </span>
        <span className="text-[#e8eaed]">{step.cmd}</span>
        {output ? `\n${output.replace(/\s+$/, "")}` : ""}
        {running && <span className="terminal-cursor" aria-hidden />}
      </pre>
    </div>
  );
});

// ---------------------------------------------------------------------------------------------
// Code card — what a write/edit actually put in the file
// ---------------------------------------------------------------------------------------------

const REHYPE = [rehypeHighlight];

const CodePreview = memo(function CodePreview({ step }: { step: BuildStep }) {
  if (!step.code) return null;
  if (step.lang === "diff") {
    return (
      <pre className="max-h-64 overflow-auto py-1.5 font-mono text-[11.5px] leading-[1.55]">
        {step.code.split("\n").map((line, i) => (
          <div
            key={i}
            className={cn(
              "px-3 whitespace-pre",
              line.startsWith("+ ") && "bg-emerald-500/10 text-emerald-300",
              line.startsWith("- ") && "bg-red-500/10 text-red-300",
              line === "⋯" && "text-subtle",
            )}
          >
            {line || " "}
          </div>
        ))}
      </pre>
    );
  }
  const fence = step.code.includes("```") ? "````" : "```";
  return (
    <div className="md build-code max-h-64 overflow-auto">
      <ReactMarkdown rehypePlugins={REHYPE} components={{ pre: ({ children }) => <pre className="px-3 py-2">{children}</pre> }}>
        {`${fence}${step.lang && step.lang !== "text" ? step.lang : ""}\n${step.code}\n${fence}`}
      </ReactMarkdown>
    </div>
  );
});

function DiffCounts({ step }: { step: BuildStep }) {
  if (step.added == null && step.removed == null) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-[11px]">
      {step.added ? <span className="text-emerald-400">+{step.added}</span> : null}
      {step.removed ? <span className="text-red-400">−{step.removed}</span> : null}
    </span>
  );
}

function fileName(step: BuildStep) {
  return step.path ?? step.label.replace(/^(Wrote|Writing|Edited|Editing|Read) /, "").replace(/…$/, "");
}

function FileRow({ step }: { step: BuildStep }) {
  const [open, setOpen] = useState(false);
  const running = step.state === "running";
  const expandable = Boolean(step.code) || (step.state === "error" && Boolean(step.detail));
  const editing = /^Edit/i.test(step.label) || step.lang === "diff";
  return (
    <div className="step-enter">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px]", expandable && "hover:bg-white/[0.04]")}
      >
        {running ? <span className="build-orb scale-75" aria-hidden /> : step.state === "error" ? <AlertCircle className="size-3.5 shrink-0 text-danger" /> : <FileCode2 className="size-3.5 shrink-0 text-muted" />}
        <span className={cn("min-w-0 flex-1 truncate font-mono text-[12px]", running ? "shimmer-text" : step.state === "error" ? "text-danger" : "text-foreground/90")}>
          {running ? `${editing ? "Editing" : "Writing"} ${fileName(step)}` : fileName(step)}
        </span>
        <DiffCounts step={step} />
        {expandable && <ChevronRight className={cn("size-3 shrink-0 text-subtle transition-transform duration-200", open && "rotate-90")} />}
      </button>
      {expandable && (
        <Collapse open={open}>
          <div className="mx-2 mt-0.5 mb-1.5 overflow-hidden rounded-lg border border-white/[0.06] bg-[#0f0f10]">
            {step.code ? <CodePreview step={step} /> : <pre className="p-2 font-mono text-[11px] whitespace-pre-wrap text-danger">{step.detail}</pre>}
          </div>
        </Collapse>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

function StepRow({ step }: { step: BuildStep }) {
  // Terminal steps stay open while running and after an error; a success folds away (click to reopen).
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // Narration between actions ("Installing dependencies…") — a plain thought line, not a command.
  if (step.kind === "note") {
    return (
      <div className="step-enter relative py-1 pl-6 text-sm text-foreground">
        <span className="absolute top-2 left-0 flex size-4 items-center justify-center bg-background">
          <Lightbulb className="size-3.5 text-muted" />
        </span>
        {step.label}
      </div>
    );
  }
  const terminal = Boolean(step.cmd) && (step.kind === "run" || step.kind === "start");
  const open = userOpen ?? (terminal && step.state !== "ok");
  const expandable = terminal || Boolean(step.detail);
  return (
    <div className="step-enter relative pl-6">
      <span className="absolute top-[13px] left-0 flex size-4 -translate-y-1/2 items-center justify-center bg-background">
        <StepIcon step={step} />
      </span>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setUserOpen(!open)}
        className={cn("flex w-full items-center gap-2 py-1 text-left text-sm", expandable && "hover:text-foreground")}
      >
        {verb(step) && <span className="shrink-0 text-foreground">{verb(step)}</span>}
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            step.state === "error" ? "text-danger" : step.state === "running" ? "shimmer-text" : "text-muted",
          )}
        >
          {step.label}
        </span>
        <StepTime step={step} />
        {expandable && <ChevronRight className={cn("size-3.5 shrink-0 text-subtle transition-transform duration-200", open && "rotate-90")} />}
      </button>
      {expandable && (
        <Collapse open={open}>
          {terminal ? (
            <MiniTerminal step={step} />
          ) : (
            <pre className="mb-1 max-h-48 overflow-auto rounded-lg bg-chip p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted">
              {step.detail}
            </pre>
          )}
        </Collapse>
      )}
    </div>
  );
}

function WriteGroup({ steps, streaming }: { steps: BuildStep[]; streaming: boolean }) {
  const running = steps.some((st) => st.state === "running");
  const failed = steps.some((st) => st.state === "error");
  // Open while files are being written live, so the user watches them land; folded in history.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? streaming;
  const added = steps.reduce((n, st) => n + (st.added ?? 0), 0);
  const removed = steps.reduce((n, st) => n + (st.removed ?? 0), 0);
  const anyEdit = steps.some((st) => /^Edit/i.test(st.label) || st.lang === "diff");
  return (
    <div className="step-enter relative pl-6">
      <span className="absolute top-[13px] left-0 flex size-4 -translate-y-1/2 items-center justify-center bg-background">
        {running ? <span className="build-orb" aria-hidden /> : failed ? <AlertCircle className="size-3.5 text-danger" /> : <FilePen className="size-3.5 text-muted" />}
      </span>
      <button type="button" onClick={() => setUserOpen(!open)} className="flex w-full items-center gap-2 py-1 text-left text-sm hover:text-foreground">
        <span className="shrink-0 text-foreground">
          {running ? (anyEdit ? "Editing" : "Writing") : anyEdit ? "Edited" : "Wrote"} {steps.length} file{steps.length === 1 ? "" : "s"}
        </span>
        {!open && <span className="min-w-0 flex-1 truncate text-muted">{steps.map(fileName).join(", ")}</span>}
        {open && <span className="flex-1" />}
        <DiffCounts step={{ ...steps[0]!, added: added || undefined, removed: removed || undefined }} />
        <ChevronRight className={cn("size-3.5 shrink-0 text-subtle transition-transform duration-200", open && "rotate-90")} />
      </button>
      <Collapse open={open}>
        <div className="mb-1 rounded-xl border border-border/70 bg-composer/60 py-1">
          {steps.map((st) => (
            <FileRow key={st.id} step={st} />
          ))}
        </div>
      </Collapse>
    </div>
  );
}

/** The step running right now, spelled out — "Running npm install", "Writing src/App.jsx". */
function currentActivity(steps: BuildStep[]): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const st = steps[i]!;
    if (st.state !== "running" || st.kind === "note") continue;
    if (st.kind === "run" && st.cmd) return `Running ${st.cmd.length > 60 ? `${st.cmd.slice(0, 60)}…` : st.cmd}`;
    if (st.kind === "write") return st.label.replace(/…$/, "");
    return st.label.replace(/…$/, "");
  }
  return null;
}

/** The plan Build Mode drafts before coding. As a proposal (status pending/revised, nothing built yet)
 *  it reads as a full plan to judge — what gets built, the architecture, numbered steps; once a build
 *  runs it becomes the live checklist, ticked off as items finish. */
export function PlanCard({ plan }: { plan: NonNullable<BuildInfo["plan"]> }) {
  const proposal = plan.status === "pending" || plan.status === "revised" || (plan.status === "approved" && plan.items.every((i) => i.state === "todo"));
  const [showArch, setShowArch] = useState(plan.status === "pending");
  const done = plan.items.filter((i) => i.state === "done").length;
  const badge =
    plan.status === "pending" ? "Waiting for your approval" : plan.status === "revised" ? "Replaced by a newer plan" : plan.status === "approved" && proposal ? "Approved" : null;
  return (
    <div className={cn("mb-3 w-full rounded-2xl border border-border bg-composer px-4 py-3", plan.status === "revised" && "opacity-60")}>
      <div className="flex items-center gap-2 text-sm font-semibold">
        <ListChecks className="size-4" /> {proposal ? "Build plan" : "Plan"}
        {badge ? (
          <span className={cn("ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium", plan.status === "pending" ? "bg-foreground text-background" : "bg-chip text-muted")}>{badge}</span>
        ) : (
          <span className="ml-auto text-xs font-normal text-muted">
            {done}/{plan.items.length}
          </span>
        )}
      </div>
      {!proposal && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-chip">
          <div className="h-full rounded-full bg-foreground transition-all duration-500" style={{ width: `${(done / plan.items.length) * 100}%` }} />
        </div>
      )}
      {plan.summary && (
        <div className="mt-3">
          <p className="text-xs font-medium text-subtle">What I'll build</p>
          <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-foreground">{plan.summary}</p>
        </div>
      )}
      {plan.architecture && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowArch((v) => !v)} className="flex items-center gap-1 text-xs font-medium text-subtle hover:text-foreground">
            Architecture <ChevronRight className={cn("size-3 transition-transform", showArch && "rotate-90")} />
          </button>
          <Collapse open={showArch}>
            <p className="mt-1 text-xs leading-relaxed whitespace-pre-wrap text-muted">{plan.architecture}</p>
          </Collapse>
        </div>
      )}
      {proposal && <p className="mt-3 text-xs font-medium text-subtle">Steps</p>}
      <ul className={cn("space-y-1", proposal ? "mt-1" : "mt-2")}>
        {plan.items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {proposal ? (
                <span className="text-xs text-subtle tabular-nums">{i + 1}.</span>
              ) : item.state === "done" ? (
                <span className="plan-check flex size-4 items-center justify-center rounded-full bg-foreground text-background">
                  <Check className="size-3" strokeWidth={3} />
                </span>
              ) : item.state === "doing" ? (
                <span className="build-orb" aria-hidden />
              ) : (
                <span className="size-3.5 rounded-full border border-border" />
              )}
            </span>
            <span
              className={cn(
                "transition-colors duration-300",
                item.state === "done" ? "text-muted line-through decoration-border" : item.state === "doing" ? "text-foreground" : "text-foreground/80",
              )}
            >
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Build Mode" start-up card: shown the instant a build starts (before any step exists) and as a small
 *  pill above the live steps, so it's obvious Friday switched into building an actual project. */
export function BuildBanner({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <span className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-chip px-2.5 py-1 text-xs font-medium text-foreground">
        <Hammer className="size-3" /> Build Mode
      </span>
    );
  }
  return (
    <div className="build-banner w-full px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-xl bg-chip">
          <Hammer className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            Build Mode <span className="build-orb" aria-hidden />
          </div>
          <div className="text-xs text-muted">Spinning up a sandbox to build, install, run and test your project…</div>
        </div>
      </div>
    </div>
  );
}

/** Build Mode's task list: while working, rows joined by a thin vertical line — live terminals for
 *  commands, file cards for writes/edits — with the current activity spelled out at the bottom; once
 *  finished it folds into one "Worked for 7m 39s ›" line that expands to the same rows. */
export function BuildSteps({ build, streaming }: { build: BuildInfo; streaming: boolean }) {
  const setCanvasOpen = useChat((s) => s.setCanvasOpen);
  const [elapsed, setElapsed] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!streaming) return;
    const started = Date.now() - elapsed * 1000;
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  // Consecutive file writes fold into one "Wrote 9 files" group so a big scaffold doesn't bury the
  // commands that matter; each file inside still opens to show its code or diff.
  const groups: Array<BuildStep | BuildStep[]> = [];
  for (const step of build.steps) {
    const prev = groups[groups.length - 1];
    if (step.kind === "write" && Array.isArray(prev)) prev.push(step);
    else if (step.kind === "write") groups.push([step]);
    else groups.push(step);
  }
  const rows = (
    <div className="relative">
      <span className="absolute top-3 bottom-3 left-[7.5px] w-px bg-border" aria-hidden />
      {groups.map((g) => (Array.isArray(g) ? <WriteGroup key={g[0]!.id} steps={g} streaming={streaming} /> : <StepRow key={g.id} step={g} />))}
    </div>
  );

  // A chat turn that only used tools (web search, reading a page, Gmail…) isn't Build Mode.
  const toolsOnly = build.steps.length > 0 && build.steps.every((st) => st.kind === "tool") && !build.plan;

  if (streaming) {
    const activity = currentActivity(build.steps);
    return (
      <div className="w-full">
        {!toolsOnly && <BuildBanner compact />}
        {build.plan && <PlanCard plan={build.plan} />}
        {rows}
        <div className="flex min-w-0 items-center gap-2 pt-2 text-sm text-muted">
          <span className="build-orb shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {activity ? <span className="shimmer-text">{activity}</span> : "Thinking about the next step"}
          </span>
          <span className="shrink-0 text-subtle tabular-nums">· {formatDuration(elapsed)}</span>
        </div>
      </div>
    );
  }

  if (build.plan && build.steps.length === 0 && !build.previewUrl) return <PlanCard plan={build.plan} />;

  const seconds = build.elapsedMs != null ? build.elapsedMs / 1000 : 0;
  return (
    <div className="w-full">
      {build.plan && <PlanCard plan={build.plan} />}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-sm text-muted hover:text-foreground"
      >
        {toolsOnly
          ? `Used ${build.steps.length} tool${build.steps.length === 1 ? "" : "s"}`
          : seconds > 0
            ? `Worked for ${formatDuration(seconds)}`
            : `${build.steps.length} steps`}
        <ChevronRight className={cn("size-3.5 transition-transform duration-200", expanded && "rotate-90")} />
      </button>
      <Collapse open={expanded}>
        <div className="mt-2">{expanded && rows}</div>
      </Collapse>
      {build.prUrl && (
        <a
          href={build.prUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-2 rounded-full bg-chip px-3 py-1.5 text-xs text-foreground hover:bg-chip/70"
        >
          <GitPullRequest className="size-3.5" /> View pull request
        </a>
      )}
      {build.previewUrl && (
        <button
          type="button"
          onClick={() => setCanvasOpen(true)}
          className="mt-2 flex items-center gap-2 rounded-full bg-chip px-3 py-1.5 text-xs text-foreground hover:bg-chip/70"
        >
          Open live preview
        </button>
      )}
    </div>
  );
}

/** The downloadable project as a file card, like "algozz-landing.zip · Archive · 29.69 KB · Download". */
export function ProjectZipCard({ build, conversationId }: { build: BuildInfo; conversationId?: string }) {
  const [error, setError] = useState<string | null>(null);
  if (!build.zipBytes || !conversationId) return null;
  return (
    <div className="w-full">
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-composer px-4 py-3">
        <FileArchive className="size-9 shrink-0 text-muted" strokeWidth={1.25} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{build.zipName ?? "project.zip"}</div>
          <div className="text-xs text-muted">Archive · {formatBytes(build.zipBytes)}</div>
        </div>
        <button
          type="button"
          onClick={() => void downloadProjectZip(conversationId).catch((e) => setError(e instanceof Error ? e.message : "Download failed"))}
          className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm hover:bg-chip"
        >
          <Download className="size-4" /> Download
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
