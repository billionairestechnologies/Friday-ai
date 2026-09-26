import { getProviderAdapter } from "../providers/registry.js";
import type { AgentMessage, ToolCall, ToolTurnResult } from "../providers/toolCalling.js";
import type { ChatMessage, ProviderAdapter } from "../providers/types.js";
import { getWorkingKeyForProvider, type ChatCandidate } from "../providerService.js";
import { emptyTokenUsage, estimateTokenUsageFromText, mergeTokenUsage, type TokenUsage } from "../tokenUsage.js";
import type { BuildStep } from "../chat/types.js";
import { clip, type FridayTool, type ToolContext } from "./tools/types.js";

/**
 * The chat agent loop: stream a model turn with tools available; if it calls tools, run them
 * (independent calls in parallel), feed the results back, and repeat until the model answers in
 * text or the round budget runs out (the last round forces a text answer).
 */

export const MAX_TOOL_ROUNDS = 8;
const MAX_RESULT_CHARS = 24_000;
const TOOL_TIMEOUT_MS = 45_000;

export type ToolLoopResult = {
  candidate: ChatCandidate | null;
  text: string;
  usage: TokenUsage;
  steps: BuildStep[];
  toolCallCount: number;
  /** Names of every tool called, in order (for usage metering). */
  toolNames: string[];
  /** Set when the loop could not produce anything (caller should fall back to plain streaming). */
  error?: string;
};

export function supportsTools(candidate: ChatCandidate): boolean {
  try {
    return typeof getProviderAdapter(candidate.slug).chatStreamWithTools === "function";
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runToolLoop(opts: {
  candidates: ChatCandidate[];
  history: ChatMessage[];
  tools: FridayTool[];
  ctx: ToolContext;
  onText: (delta: string) => void;
  onStep: (step: BuildStep) => void;
  maxRounds?: number;
  /** Adapter + key lookup; injectable for tests. */
  resolve?: (candidate: ChatCandidate) => Promise<{ adapter: ProviderAdapter; apiKey: string }>;
}): Promise<ToolLoopResult> {
  const resolve =
    opts.resolve ??
    (async (c: ChatCandidate) => ({ adapter: getProviderAdapter(c.slug), apiKey: await getWorkingKeyForProvider(c.slug) }));
  const { tools, ctx, onStep } = opts;
  const maxRounds = opts.maxRounds ?? MAX_TOOL_ROUNDS;
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const specs = tools.map((t) => t.spec);
  const messages: AgentMessage[] = [...opts.history];
  const steps: BuildStep[] = [];
  let usage = emptyTokenUsage();
  let text = "";
  let stepSeq = 0;
  let toolCallCount = 0;
  const toolNames: string[] = [];
  let candidate: ChatCandidate | null = null;

  // Between rounds the model often narrates ("Let me check…"); keep paragraphs separated.
  let needsBreak = false;
  const emit = (delta: string) => {
    if (!delta) return;
    if (needsBreak) {
      needsBreak = false;
      if (text && !text.endsWith("\n")) {
        text += "\n\n";
        opts.onText("\n\n");
      }
    }
    text += delta;
    opts.onText(delta);
  };

  const runCall = async (call: ToolCall): Promise<string> => {
    const tool = byName.get(call.name);
    const step: BuildStep = { id: `t${++stepSeq}`, kind: "tool", label: tool ? tool.label(call.args) : `Unknown tool ${call.name}`, state: "running" };
    steps.push(step);
    onStep({ ...step });
    if (!tool) {
      step.state = "error";
      step.detail = "Unknown tool";
      onStep({ ...step });
      return `Error: there is no tool named ${call.name}.`;
    }
    try {
      const result = await withTimeout(tool.run(call.args, ctx), TOOL_TIMEOUT_MS, call.name);
      step.state = "ok";
      step.detail = clip(result, 600);
      onStep({ ...step });
      return clip(result, MAX_RESULT_CHARS);
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed";
      step.state = "error";
      step.detail = message.slice(0, 600);
      onStep({ ...step });
      return `Error: ${message}`;
    }
  };

  for (let round = 1; round <= maxRounds; round++) {
    if (ctx.signal?.aborted) break;
    const lastRound = round === maxRounds;
    const order: ChatCandidate[] = candidate ? [candidate] : opts.candidates;
    let result: ToolTurnResult | null = null;
    let lastError: string | undefined;
    let emittedThisRound = false;
    for (const c of order) {
      try {
        const { adapter, apiKey } = await resolve(c);
        if (!adapter.chatStreamWithTools) continue;
        result = await adapter.chatStreamWithTools(
          apiKey,
          c.modelId,
          messages,
          { tools: specs, toolChoice: lastRound ? "none" : "auto", signal: ctx.signal },
          (delta) => {
            emittedThisRound = true;
            emit(delta);
          },
        );
        candidate = c;
        break;
      } catch (err) {
        lastError = `${c.slug}: ${err instanceof Error ? err.message : "failed"}`;
        if (emittedThisRound) candidate = c; // part of the reply is already on screen — it's this model's
        if (emittedThisRound || candidate) break; // can't switch models mid-reply / mid-conversation
      }
    }
    if (!result) {
      // Nothing at all happened yet → let the caller fall back to the plain streaming path.
      if (round === 1 && !emittedThisRound) return { candidate: null, text: "", usage, steps, toolCallCount, toolNames, error: lastError ?? "No tool-capable model responded" };
      return { candidate, text, usage, steps, toolCallCount, toolNames, error: lastError };
    }

    usage = mergeTokenUsage(
      usage,
      result.usage ?? estimateTokenUsageFromText(messages.reduce((n, m) => n + m.content.length, 0), result.text.length),
    );
    if (result.toolCalls.length === 0 || lastRound) break;

    toolCallCount += result.toolCalls.length;
    toolNames.push(...result.toolCalls.map((c) => c.name));
    messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
    const outputs = await Promise.all(result.toolCalls.map(runCall));
    result.toolCalls.forEach((call, i) => {
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: outputs[i]! });
    });
    needsBreak = true;
  }

  return { candidate, text, usage, steps, toolCallCount, toolNames };
}
