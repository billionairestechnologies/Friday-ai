import { AgentPlanning } from "@/components/ui/ai-planning";
import {
  ThoughtSources,
  ThoughtStep,
  ThoughtTrail,
  type SearchHit,
} from "@/components/ui/chain-of-thought";
import { ProviderLogo } from "@/components/provider-logos";
import { planningStepsFromMessage } from "@/lib/chat/planning";
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

  if (canvasOn && !message.usedThink && !searchOn) {
    return (
      <AgentPlanning
        variant="bare"
        title={live ? "Planning" : "Plan"}
        steps={planningStepsFromMessage(message)}
      />
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
          title={searchActive ? "Searching the web" : hits.length ? `Found ${hits.length} sources` : "Searched the web"}
          status={searchActive ? "active" : "complete"}
        >
          <ThoughtSources results={hits} />
        </ThoughtStep>
      )}

      {thinkOn && (
        <ThoughtStep
          title={thinkActive ? "Reasoning" : "Reasoned through it"}
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
