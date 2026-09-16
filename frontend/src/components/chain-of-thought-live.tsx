import { Check, Clock, Loader2 } from "lucide-react";
import {
  ThoughtSources,
  ThoughtStep,
  ThoughtTrail,
  type SearchHit,
} from "@/components/ui/chain-of-thought";
import { ProviderLogo } from "@/components/provider-logos";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { useElapsedSeconds, useRotatingThinkingLine } from "@/lib/chat/thinking-lines";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/lib/chat/types";

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function hitsFrom(message: ChatMessage): SearchHit[] {
  return (message.citations ?? []).slice(0, 6).map((c) => ({
    title: c.title || hostOf(c.url),
    url: c.url,
  }));
}

export function LiveChainOfThought({ message }: { message: ChatMessage }) {
  const streaming = Boolean(message.streaming);
  const status = message.status;
  const hasContent = Boolean(message.content.trim());
  const hasThink = Boolean(message.thinking?.trim());
  const hits = hitsFrom(message);
  const searchOn = Boolean(message.usedSearch);
  const thinkOn = Boolean(message.usedThink || hasThink);
  const canvasOn = Boolean(message.usedCanvas);
  const failed = Boolean(message.error);
  const agents = message.agents ?? [];
  const hasAgents = agents.length > 0;
  const synthesizing = status === "synthesizing";

  const searchActive = searchOn && streaming && status === "searching";
  const thinkActive =
    thinkOn &&
    streaming &&
    (status === "thinking" || (hasThink && !hasContent && status !== "writing"));

  // Age-banded, mode-flavored one-liners in place of the plain "Searching the web…" / "Reasoning…"
  // step text while each is actually active — see lib/chat/thinking-lines.ts.
  const { user } = useCurrentUserState();
  const searchLine = useRotatingThinkingLine(searchActive, user?.birthday, "searching");
  const thinkLine = useRotatingThinkingLine(thinkActive, user?.birthday, "thinking");
  // Canvas-only path: same "Streaming the answer…" gap, but with a "writing code" flavor and a
  // live elapsed-time counter — matching the reference product's own "Working for Ns" readout.
  const canvasWriteActive = canvasOn && streaming && (status === "writing" || hasContent);
  const canvasWriteLine = useRotatingThinkingLine(canvasWriteActive, user?.birthday, "canvas");
  const elapsedSeconds = useElapsedSeconds(canvasOn && streaming);

  const live = streaming && !failed;
  const label = failed
    ? "Stopped"
    : live
      ? searchActive
        ? "Searching"
        : hasAgents && synthesizing
          ? "Synthesizing"
          : hasAgents && !hasContent
            ? "Consulting the team"
            : canvasOn && !thinkActive
              ? "Planning"
              : thinkActive
                ? "Thinking"
                : hasContent
                  ? "Writing"
                  : "Working"
      : hasAgents
        ? `Team of ${agents.length} consulted`
        : searchOn && hits.length
          ? `Searched ${hits.length} source${hits.length === 1 ? "" : "s"}`
          : thinkOn
            ? "Thought"
            : canvasOn
              ? "Plan"
              : "Done";

  // Flat, unboxed step log for the canvas-only path — no bordered card, no collapsible header,
  // matching the reference product's plain running list instead of an accordion box. Nothing to
  // show once it's done: the chat bubble already has a "Built in Canvas" note for this case
  // (see stripVisualArtifactForChat in message-thread.tsx).
  if (canvasOn && !message.usedThink && !searchOn) {
    if (!live) return null;
    const analyzing = !canvasWriteActive;
    return (
      <div className="flex flex-col gap-1.5 py-1">
        <div
          className={cn(
            "flex items-center gap-2 text-sm",
            analyzing ? "font-medium text-foreground" : "text-muted",
          )}
        >
          {analyzing ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-sky-400" />
          ) : (
            <Check className="size-3.5 shrink-0 text-emerald-400" />
          )}
          <span>Analyzing the request</span>
        </div>
        {!analyzing && (
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin text-sky-400" />
            <span>{canvasWriteLine}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-xs text-subtle">
          <Clock className="size-3 shrink-0" />
          <span>Working for {elapsedSeconds}s</span>
        </div>
      </div>
    );
  }

  return (
    <ThoughtTrail live={live} label={label} defaultOpen={live}>
      <ThoughtStep
        title="Understanding the question"
        detail="Read the prompt and any attachments"
        status={streaming && status === "working" ? "active" : "complete"}
      />

      {hasAgents &&
        agents.map((a) => (
          <ThoughtStep
            key={`${a.slug}:${a.model}`}
            title={a.model}
            detail={a.state === "error" ? a.error ?? "Failed to respond" : undefined}
            status={a.state === "start" ? "active" : a.state === "error" ? "error" : "complete"}
            icon={<ProviderLogo slug={a.slug} className="size-3.5 shrink-0" />}
          />
        ))}

      {hasAgents && agents.length > 1 && (
        <ThoughtStep
          title={synthesizing ? "Synthesizing the final answer" : hasContent || !live ? "Synthesized the final answer" : "Synthesizing the final answer"}
          status={synthesizing ? "active" : hasContent || !live ? "complete" : "pending"}
        />
      )}

      {searchOn && (
        <ThoughtStep
          title={searchActive ? searchLine : hits.length ? `Found ${hits.length} sources` : "Searched the web"}
          status={searchActive ? "active" : "complete"}
        >
          <ThoughtSources results={hits} />
        </ThoughtStep>
      )}

      {thinkOn && (
        <ThoughtStep
          title={thinkActive ? thinkLine : "Reasoned through it"}
          status={thinkActive ? "active" : hasThink || !streaming ? "complete" : "pending"}
        >
          {hasThink && (
            <p className="mt-1 max-h-36 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap text-subtle">
              {message.thinking}
            </p>
          )}
        </ThoughtStep>
      )}

      {canvasOn && (
        <ThoughtStep
          title={streaming && !hasContent ? "Planning the canvas" : "Planned the canvas"}
          status={streaming && !hasContent ? "active" : "complete"}
        />
      )}

      {failed && (
        <ThoughtStep title="Couldn’t finish" detail={message.error} status="active" />
      )}
    </ThoughtTrail>
  );
}
