import type { ChatMessage } from "../providers/types.js";
import type { ChatCandidate } from "../providerService.js";
import type { StreamEvent } from "../chat/types.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { emptyTokenUsage, mergeTokenUsage } from "../tokenUsage.js";
import { runBuildAgent, type BuildAgentResult } from "./agent.js";
import { BuildSandbox, getProject } from "./sandbox.js";

const MAX_CONCURRENT_SUBAGENTS = 3;

/** independent workstream → its directory + the keywords that mean the request needs it. */
const WORKSTREAMS: { name: string; workdir: string; pattern: RegExp }[] = [
  { name: "Backend", workdir: "backend", pattern: /\b(backend|api|server(?!less)|database|endpoint)\b/i },
  { name: "Frontend", workdir: "frontend", pattern: /\b(frontend|front-end|ui|website|web app|landing page|react|client)\b/i },
];

/**
 * Cheap, no-LLM-call heuristic for whether a request has independent workstreams worth building in
 * parallel (e.g. "a React frontend and an Express API") vs. a single cohesive thing (most requests —
 * one dev-server app, a script, a single page). Only fans out when at least two distinct workstreams
 * are both clearly named; anything ambiguous stays a single agent, which is safer and cheaper.
 */
function detectWorkstreams(userRequest: string, existingFiles: string[]): { name: string; workdir: string }[] {
  if (existingFiles.length > 0) return []; // fan-out is for a fresh build, not touching an existing one
  const matches = WORKSTREAMS.filter((w) => w.pattern.test(userRequest));
  return matches.length >= 2 ? matches.map(({ name, workdir }) => ({ name, workdir })) : [];
}

async function setSubtaskStatus(id: string, status: string, summary?: string) {
  await supabaseAdmin
    .from("build_subtasks")
    .update({ status, summary: summary ?? null, updated_at: new Date().toISOString() })
    .eq("id", id);
}

/**
 * Entry point Build Mode calls instead of runBuildAgent directly. For most requests it's a thin
 * pass-through to a single runBuildAgent call. When the request clearly names independent
 * workstreams (e.g. a separate frontend and backend) AND it's a fresh build, it fans out: each
 * workstream gets its own confined sub-agent run (write access restricted to its subdirectory, no
 * start/PR/plan of its own — see runBuildAgent's pathPrefix), then a coordinator run (a normal,
 * unrestricted runBuildAgent call reusing the same sandbox) integrates, installs, starts and QA-gates
 * the merged result. Partial sub-agent failure is reported to the coordinator explicitly — never
 * silently dropped — so it can fix or work around whichever workstream didn't finish.
 */
export async function runBuildWithFanOut(opts: {
  userId: string;
  conversationId: string;
  history: ChatMessage[];
  candidates: ChatCandidate[];
  onEvent: (ev: StreamEvent) => void;
  signal?: AbortSignal;
}): Promise<BuildAgentResult> {
  const { userId, conversationId, history, candidates, onEvent, signal } = opts;
  const project = await getProject(conversationId);
  const userRequest = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const workstreams = detectWorkstreams(userRequest, Object.keys(project?.files ?? {})).slice(0, MAX_CONCURRENT_SUBAGENTS);

  if (workstreams.length < 2) {
    return runBuildAgent({ userId, conversationId, history, candidates, onEvent, signal });
  }

  let box: BuildSandbox;
  try {
    box = await BuildSandbox.open(userId, conversationId);
  } catch (err) {
    return {
      text: "",
      build: { steps: [] },
      usage: emptyTokenUsage(),
      candidate: null,
      error: err instanceof Error ? err.message : "Couldn't start the sandbox",
    };
  }

  const subtaskIds = new Map<string, string>();
  for (const w of workstreams) {
    const { data } = await supabaseAdmin
      .from("build_subtasks")
      .insert({ conversation_id: conversationId, name: w.name, workdir: w.workdir, status: "running" })
      .select("id")
      .single();
    if (data) subtaskIds.set(w.name, data.id as string);
  }

  const scopedHistory = (w: { name: string; workdir: string }): ChatMessage[] => [
    ...history,
    {
      role: "user",
      content:
        `This is one of ${workstreams.length} independent workstreams being built in parallel for the same project. ` +
        `You are responsible ONLY for "${w.name}" — write everything for it under the "${w.workdir}/" directory. ` +
        `Do not start any server and do not open a pull request — a coordinator step integrates and starts everything once every workstream is done.`,
    },
  ];

  const results = await Promise.allSettled(
    workstreams.map((w) =>
      runBuildAgent({
        userId,
        conversationId,
        history: scopedHistory(w),
        candidates,
        onEvent,
        signal,
        sandbox: box,
        pathPrefix: w.workdir,
        subagentLabel: w.name,
      }),
    ),
  );

  const summaries: string[] = [];
  const succeededIds: string[] = [];
  // Every sub-agent's model calls cost real tokens whether it finished or not — merged into the
  // final usage below so quota/token-ledger accounting (chat/index.ts, right after this returns)
  // never silently under-counts what parallel sub-agents actually spent.
  let subagentUsage = emptyTokenUsage();
  results.forEach((result, i) => {
    const w = workstreams[i]!;
    const id = subtaskIds.get(w.name);
    if (result.status === "fulfilled") subagentUsage = mergeTokenUsage(subagentUsage, result.value.usage);
    if (result.status === "fulfilled" && !result.value.error) {
      if (id) succeededIds.push(id);
      summaries.push(`${w.name} (${w.workdir}/): done — ${result.value.text.slice(0, 300) || "see its steps above"}`);
    } else {
      const error = result.status === "rejected" ? String(result.reason) : result.value.error;
      // No silent drop: the coordinator is told exactly which workstream is unfinished/broken so it
      // can fix it instead of quietly shipping a half-built project. Left as "error" (not "merged")
      // even after the coordinator runs, since we can't be sure it actually fixed this workstream.
      if (id) void setSubtaskStatus(id, "error", error);
      summaries.push(`${w.name} (${w.workdir}/): FAILED — ${error}. This workstream is incomplete; fix or finish it before starting the server.`);
    }
  });

  const coordinatorHistory: ChatMessage[] = [
    ...history,
    {
      role: "user",
      content:
        `The independent workstreams above have finished their part:\n${summaries.map((s) => `- ${s}`).join("\n")}\n\n` +
        `Integrate them: check each directory, wire them together (correct ports/API base URLs/config), install any missing dependencies, then start the app and verify it actually works before finishing. If a workstream failed, fix or complete it yourself.`,
    },
  ];

  const coordinatorResult = await runBuildAgent({
    userId,
    conversationId,
    history: coordinatorHistory,
    candidates,
    onEvent,
    signal,
    sandbox: box,
  });

  for (const id of succeededIds) void setSubtaskStatus(id, "merged");
  return { ...coordinatorResult, usage: mergeTokenUsage(subagentUsage, coordinatorResult.usage) };
}
