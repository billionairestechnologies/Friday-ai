import {
  AlertTriangle,
  BrainCircuit,
  Check,
  Code,
  FileText,
  Globe,
  Loader2,
  Search,
} from "lucide-react";
import type { PlanStep } from "@/components/ui/ai-planning";
import type { ChatMessage } from "./types";

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function shouldShowPlan(message: ChatMessage) {
  return Boolean(message.usedThink || message.usedSearch || message.usedCanvas || message.agents?.length);
}

export function planTitle(message: ChatMessage) {
  if (message.streaming) {
    if (message.status === "searching") return "Searching the web";
    if (message.status === "thinking") return "Friday is planning";
    if (message.status === "writing") return "Writing the reply";
    return "Friday is planning";
  }
  if (message.error) return "Plan interrupted";
  return "Plan";
}

export function planningStepsFromMessage(message: ChatMessage, writingLine?: string): PlanStep[] {
  const streaming = Boolean(message.streaming);
  const status = message.status;
  const hasContent = Boolean(message.content.trim());
  const hasThink = Boolean(message.thinking?.trim());
  const cites = message.citations ?? [];
  const failed = Boolean(message.error);

  const analyzeActive = streaming && status === "working";
  const analyzeDone = !analyzeActive;

  const searchActive = Boolean(message.usedSearch) && streaming && status === "searching";
  const searchDone =
    Boolean(message.usedSearch) &&
    (cites.length > 0 ||
      status === "thinking" ||
      status === "writing" ||
      hasContent ||
      (!streaming && !searchActive));

  const thinkActive =
    Boolean(message.usedThink || hasThink) &&
    streaming &&
    (status === "thinking" || (hasThink && !hasContent && status !== "writing"));
  const thinkDone =
    Boolean(message.usedThink || hasThink) &&
    (hasContent || status === "writing" || (!streaming && hasThink));

  const writeActive = streaming && (status === "writing" || hasContent);
  const writeDone = hasContent && !streaming;

  const steps: PlanStep[] = [
    {
      id: "analyze",
      title: "Analyze the request",
      status: failed && !hasThink && cites.length === 0 && !hasContent
        ? "error"
        : analyzeActive
          ? "active"
          : analyzeDone
            ? "success"
            : "pending",
      icon: <Search className="size-3.5" />,
      duration: analyzeActive ? "…" : undefined,
      defaultExpanded: analyzeActive,
      content: (
        <div className="space-y-2 font-mono text-[11px] text-muted">
          <div className="flex items-start gap-2 font-medium text-emerald-400">
            <Check className="mt-0.5 size-3.5 shrink-0" />
            <span>Read the question and any attachments</span>
          </div>
        </div>
      ),
    },
  ];

  if (message.usedSearch) {
    steps.push({
      id: "search",
      title: "Search the web",
      status: failed && searchActive
        ? "error"
        : searchActive
          ? "active"
          : searchDone
            ? "success"
            : "pending",
      icon: <Globe className="size-3.5" />,
      duration: searchActive ? "…" : cites.length ? `${cites.length} src` : undefined,
      defaultExpanded: searchActive || cites.length > 0,
      content: (
        <div className="space-y-3 font-mono text-[11px]">
          <div className="flex items-center gap-2 text-muted">
            {searchActive ? (
              <>
                <Loader2 className="size-3.5 animate-spin text-sky-400" />
                <span>Querying the live web…</span>
              </>
            ) : (
              <>
                <FileText className="size-3.5 text-search" />
                <span>
                  {cites.length
                    ? `Retrieved ${cites.length} source${cites.length === 1 ? "" : "s"}`
                    : "Web search finished"}
                </span>
              </>
            )}
          </div>
          {cites.length > 0 && (
            <ul className="space-y-1.5 rounded-md border border-border bg-elevated p-3 text-muted">
              {cites.map((c) => (
                <li key={c.url} className="truncate">
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground/90 hover:underline"
                  >
                    {c.title || hostOf(c.url)}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ),
    });
  }

  if (message.usedThink || hasThink) {
    steps.push({
      id: "think",
      title: "Think through the answer",
      status: failed && thinkActive
        ? "error"
        : thinkActive
          ? "active"
          : thinkDone
            ? "success"
            : "pending",
      icon: <BrainCircuit className="size-3.5" />,
      duration: thinkActive ? "…" : undefined,
      defaultExpanded: thinkActive || hasThink,
      content: (
        <div className="space-y-3 font-mono text-[11px]">
          <div className="flex items-center gap-2 font-medium text-sky-400">
            {thinkActive ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <BrainCircuit className="size-3.5" />
            )}
            <span>{thinkActive ? "Reasoning…" : "Reasoning complete"}</span>
          </div>
          {hasThink && (
            <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-background p-3 leading-relaxed whitespace-pre-wrap text-muted">
              {message.thinking}
            </div>
          )}
        </div>
      ),
    });
  }

  steps.push({
    id: "write",
    title: failed ? "Could not finish the reply" : message.usedCanvas ? "Generate the code" : "Write the reply",
    status: failed && !writeDone ? "error" : writeDone ? "success" : writeActive ? "active" : "pending",
    icon: failed ? <AlertTriangle className="size-3.5" /> : <Code className="size-3.5" />,
    duration: writeActive ? "…" : undefined,
    defaultExpanded: failed,
    content: failed ? (
      <div className="rounded-md border border-rose-500/20 bg-rose-500/10 p-3 font-mono text-[11px] text-rose-400">
        {message.error}
      </div>
    ) : writeActive ? (
      <div className="flex items-center gap-2 font-mono text-[11px] text-sky-400">
        <Loader2 className="size-3.5 animate-spin" />
        <span>{writingLine ?? "Streaming the answer…"}</span>
      </div>
    ) : undefined,
  });

  return steps;
}
