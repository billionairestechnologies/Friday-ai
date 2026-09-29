import type { AgentMessage } from "../providers/toolCalling.js";

/**
 * Context summarisation for long native-tool builds. Dropping old file bodies (compactToolCallArgs)
 * and shortening old tool results (compactToolResults) buys a lot, but a 60+ round build still
 * outgrows any context window. Past a budget, everything but the most recent turns is replaced by a
 * model-written summary — the same idea as Claude Code's auto-compact — so the agent keeps its
 * thread (what exists, what failed, what's left) instead of losing it or erroring out.
 */

export function transcriptChars(messages: AgentMessage[]): number {
  return messages.reduce((n, m) => {
    const calls = "toolCalls" in m && m.toolCalls ? JSON.stringify(m.toolCalls).length : 0;
    return n + m.content.length + calls;
  }, 0);
}

/**
 * Where to cut: the index of the first message to KEEP. It must be an assistant message — so no tool
 * result is ever separated from the assistant turn that called it (every dialect rejects an orphaned
 * tool result), and the kept tail can follow a user-role summary message. Returns -1 when there is
 * nothing worth summarising.
 */
export function planSummaryCut(messages: AgentMessage[], keepRecent: number): number {
  const firstBody = messages.findIndex((m) => m.role !== "system");
  if (firstBody < 0) return -1;
  const latest = messages.length - keepRecent;
  for (let i = latest; i > firstBody + 1; i--) {
    if (messages[i]?.role === "assistant") return i;
  }
  return -1;
}

/** Plain-text rendering of the part being summarised, for the summariser model. */
export function renderTranscript(messages: AgentMessage[], maxChars = 60_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      lines.push(`RESULT (${m.name}): ${m.content.slice(0, 1200)}`);
    } else if ("toolCalls" in m && m.toolCalls?.length) {
      if (m.content.trim()) lines.push(`AGENT: ${m.content.trim()}`);
      for (const c of m.toolCalls) {
        const args = { ...c.args };
        if (typeof args.content === "string") args.content = `(${args.content.length} chars)`;
        lines.push(`CALL ${c.name} ${JSON.stringify(args).slice(0, 400)}`);
      }
    } else {
      lines.push(`${m.role === "user" ? "USER" : "AGENT"}: ${m.content.slice(0, 2000)}`);
    }
  }
  const text = lines.join("\n");
  // Keep the end if it's too long — the most recent part of the summarised span matters most.
  return text.length > maxChars ? `…${text.slice(text.length - maxChars)}` : text;
}

export const SUMMARY_PROMPT =
  "You are compacting the working memory of a coding agent in the middle of a build. Summarise the transcript below " +
  "for the agent itself, so it can continue seamlessly. Be specific and factual, in this structure:\n" +
  "## Goal — what the user asked for (keep their exact requirements)\n" +
  "## Done so far — files created/changed (path: purpose), dependencies installed, servers started (command + port)\n" +
  "## Current state — what works, what is failing right now and the exact error text\n" +
  "## Tried and failed — approaches that did not work (so they are not repeated)\n" +
  "## Next steps — the remaining plan items in order\n" +
  "Under 700 words. No preamble.";

/** Rebuilds the message list: system prompt(s), one user message with the summary, then the kept tail. */
export function applySummary(messages: AgentMessage[], cut: number, summary: string, userRequest: string): AgentMessage[] {
  const system = messages.filter((m, i) => m.role === "system" && i < cut);
  return [
    ...system,
    {
      role: "user",
      content:
        `ORIGINAL REQUEST:\n${userRequest.slice(0, 4000)}\n\n` +
        `The earlier part of this build was compacted to save context. Summary of the work so far:\n${summary}\n\n` +
        "Continue from here — use read_file / list_files if you need exact file contents.",
    },
    ...messages.slice(cut),
  ];
}
