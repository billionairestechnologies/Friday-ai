import type { ChatCandidate } from "../../providerService.js";
import { MAX_SUBAGENTS, parseSubTasks, runSubAgents } from "../../projectBuild/subagents.js";
import type { FridayTool } from "./types.js";

/**
 * Parallel research for Deep Research: the main model splits the question into sub-questions and
 * hands each to a helper with its own fresh context that searches and reads on its own — all at the
 * same time. Before this, a Deep Research turn ran every search one after another in one context, so
 * a 10-source report took 10× the time and the transcript ballooned until compaction dropped detail.
 */
export function researchAgentsTool(candidates: ChatCandidate[]): FridayTool {
  let seq = 0;
  return {
    spec: {
      name: "research_in_parallel",
      description:
        `Research up to ${MAX_SUBAGENTS} independent sub-questions AT THE SAME TIME, each by a helper with its own web search and ` +
        "page reading, and get back a short cited report from each. Use it early in a deep research task once you have split " +
        "the question into sub-questions (e.g. market size, competitors, regulation, recent news). Give each helper complete, " +
        "specific instructions (it sees nothing of this conversation) and ask for exact figures, dates and source URLs. Then " +
        "cross-check, fill gaps with your own searches, and write the report.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description: `1-${MAX_SUBAGENTS} independent sub-questions`,
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Short name shown to the user" },
                instructions: { type: "string", description: "What to find out and what the report must contain (figures, dates, URLs)" },
              },
              required: ["title", "instructions"],
            },
          },
        },
        required: ["tasks"],
      },
    },
    label: (args) => {
      const n = parseSubTasks({ tasks: (args as { tasks?: unknown }).tasks }).length;
      return `Researching ${n} question${n === 1 ? "" : "s"} in parallel`;
    },
    async run(args, ctx) {
      const raw = (args as { tasks?: unknown[] }).tasks ?? [];
      const tasks = parseSubTasks({ tasks: raw.map((t) => ({ ...(t as object), kind: "research" })) });
      if (!tasks.length) throw new Error("Give 1-4 tasks, each with a title and instructions.");
      const run = await runSubAgents({
        tasks,
        candidates,
        reader: null,
        projectNote: "You are researching on the web for a report.",
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        signal: ctx.signal,
        onCite: ctx.onCite,
        nextStepId: () => `r${Date.now().toString(36)}${++seq}`,
        onUpdate: (step) => ctx.onStep?.(step),
      });
      ctx.onUsage?.(run.usage);
      return run.output;
    },
  };
}
