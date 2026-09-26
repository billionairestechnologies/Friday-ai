import { useEffect, useState } from "react";
import { AlertCircle, Check, ChevronRight, Download, FileArchive, FilePen, Hammer, Lightbulb, ListChecks, Play, Terminal, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BuildInfo, BuildStep } from "@/lib/chat/types";
import { useChat } from "@/lib/chat/store";
import { downloadProjectZip } from "@/components/build-preview";

function StepIcon({ step }: { step: BuildStep }) {
  if (step.state === "running") return <span className="build-orb" aria-hidden />;
  if (step.state === "error") return <AlertCircle className="size-3.5 text-danger" />;
  const Icon =
    step.kind === "tool" ? Wrench : step.kind === "write" || step.kind === "read" ? FilePen : step.kind === "start" ? Play : Terminal;
  return <Icon className="size-3.5 text-muted" />;
}

function verb(step: BuildStep): string {
  if (step.kind === "run") return step.state === "running" ? "Running command" : "Ran command";
  if (step.kind === "start") return step.state === "running" ? "Starting server" : "Started server";
  return "";
}

function StepRow({ step }: { step: BuildStep }) {
  const [open, setOpen] = useState(false);
  // Narration between actions ("Installing dependencies…") — a plain thought line, not a command.
  if (step.kind === "note") {
    return (
      <div className="relative py-1 pl-6 text-sm text-foreground">
        <span className="absolute top-2 left-0 flex size-4 items-center justify-center bg-background">
          <Lightbulb className="size-3.5 text-muted" />
        </span>
        {step.label}
      </div>
    );
  }
  const expandable = Boolean(step.detail);
  return (
    <div className="relative pl-6">
      <span className="absolute top-1/2 left-0 flex size-4 -translate-y-1/2 items-center justify-center bg-background">
        <StepIcon step={step} />
      </span>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        className={cn("flex w-full items-center gap-2 py-1 text-left text-sm", expandable && "hover:text-foreground")}
      >
        {verb(step) && <span className="text-foreground">{verb(step)}</span>}
        <span className={cn("min-w-0 flex-1 truncate", step.state === "error" ? "text-danger" : "text-muted")}>{step.label}</span>
        {expandable && <ChevronRight className={cn("size-3.5 text-subtle transition-transform", open && "rotate-90")} />}
      </button>
      {open && step.detail && (
        <pre className="mb-1 max-h-48 overflow-auto rounded-lg bg-chip p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted">
          {step.detail}
        </pre>
      )}
    </div>
  );
}

function WriteGroup({ steps }: { steps: BuildStep[] }) {
  const [open, setOpen] = useState(false);
  const running = steps.some((st) => st.state === "running");
  const failed = steps.some((st) => st.state === "error");
  return (
    <div className="relative pl-6">
      <span className="absolute top-1/2 left-0 flex size-4 -translate-y-1/2 items-center justify-center bg-background">
        {running ? <span className="build-orb" aria-hidden /> : failed ? <AlertCircle className="size-3.5 text-danger" /> : <FilePen className="size-3.5 text-muted" />}
      </span>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 py-1 text-left text-sm hover:text-foreground">
        <span className="text-foreground">{running ? "Editing" : "Edited"} {steps.length} file{steps.length === 1 ? "" : "s"}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{steps.map((st) => st.label.replace(/^(Wrote|Writing) /, "").replace(/…$/, "")).join(", ")}</span>
        <ChevronRight className={cn("size-3.5 text-subtle transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mb-1 rounded-lg bg-chip p-2 font-mono text-[11px] leading-relaxed text-muted">
          {steps.map((st) => (
            <div key={st.id}>{st.label.replace(/^(Wrote|Writing) /, "").replace(/…$/, "")}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The architecture + todo checklist Build Mode drafts before coding, ticked off live as items finish. */
function PlanCard({ plan }: { plan: NonNullable<BuildInfo["plan"]> }) {
  const [showArch, setShowArch] = useState(false);
  const done = plan.items.filter((i) => i.state === "done").length;
  return (
    <div className="mb-3 w-full rounded-2xl border border-border bg-composer px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <ListChecks className="size-4" /> Plan
        <span className="ml-auto text-xs font-normal text-muted">
          {done}/{plan.items.length}
        </span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-chip">
        <div className="h-full rounded-full bg-foreground transition-all duration-500" style={{ width: `${(done / plan.items.length) * 100}%` }} />
      </div>
      {plan.architecture && (
        <div className="mt-2">
          <button type="button" onClick={() => setShowArch((v) => !v)} className="flex items-center gap-1 text-xs text-muted hover:text-foreground">
            Architecture <ChevronRight className={cn("size-3 transition-transform", showArch && "rotate-90")} />
          </button>
          {showArch && <p className="mt-1 text-xs leading-relaxed whitespace-pre-wrap text-muted">{plan.architecture}</p>}
        </div>
      )}
      <ul className="mt-2 space-y-1">
        {plan.items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {item.state === "done" ? (
                <span className="flex size-4 items-center justify-center rounded-full bg-foreground text-background">
                  <Check className="size-3" strokeWidth={3} />
                </span>
              ) : item.state === "doing" ? (
                <span className="build-orb" aria-hidden />
              ) : (
                <span className="size-3.5 rounded-full border border-border" />
              )}
            </span>
            <span className={cn(item.state === "done" ? "text-muted line-through decoration-border" : "text-foreground")}>{item.text}</span>
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

function formatDuration(totalSeconds: number) {
  const s = Math.max(0, Math.round(totalSeconds));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(2)} KB`;
}

/** Build Mode's task list, laid out like the reference product: while working, flat rows
 *  ("Ran command · Install dependencies") joined by a thin vertical line, and "Working for 15s";
 *  once finished it folds into one "Worked for 7m 39s ›" line that expands to the same rows. */
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

  // Consecutive file writes fold into one "Edited 9 files" row (like the reference product) so a big
  // scaffold doesn't bury the commands that matter.
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
      {groups.map((g) => (Array.isArray(g) ? <WriteGroup key={g[0]!.id} steps={g} /> : <StepRow key={g.id} step={g} />))}
    </div>
  );

  // A chat turn that only used tools (web search, reading a page, Gmail…) isn't Build Mode.
  const toolsOnly = build.steps.length > 0 && build.steps.every((st) => st.kind === "tool") && !build.plan;

  if (streaming) {
    return (
      <div className="w-full">
        {!toolsOnly && <BuildBanner compact />}
        {build.plan && <PlanCard plan={build.plan} />}
        {rows}
        <div className="flex items-center gap-2 pt-2 text-sm text-muted">
          <span className="build-orb" aria-hidden /> Working for {formatDuration(elapsed)}
        </div>
      </div>
    );
  }

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
        <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
      </button>
      {expanded && <div className="mt-2">{rows}</div>}
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
