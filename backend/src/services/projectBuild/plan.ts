import { supabaseAdmin } from "../../config/supabase.js";
import { getProviderAdapter } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { getWorkingKeyForProvider, type ChatCandidate } from "../providerService.js";
import { estimateTokenUsageFromText, type TokenUsage } from "../tokenUsage.js";
import type { BuildMeta, BuildPlan } from "../chat/types.js";

/**
 * Build Mode's plan-approval round. A new project (or a big change) gets a full plan first — what
 * will be built, the stack/structure, and the step-by-step checklist — and NOTHING runs until the
 * user approves it: no sandbox, no code, no cost. Any other reply to a pending plan is feedback and
 * gets a revised plan. Before this the plan card was drafted and the agent started coding in the
 * same breath, so the user only saw the plan once it was already being executed.
 */

/** Stored as the plan message's text (followed by the rendered plan, so later turns see it). */
export const PLAN_MARKER = "Here's the plan. Approve it to start building, or tell me what to change.";
/** The client's Approve button sends exactly this. */
export const PLAN_APPROVE_TEXT = "Approved — build it as planned.";

const PLAN_TIMEOUT_MS = 75_000;

const PLAN_PROMPT = `You are the tech lead of a coding agent that will build the user's request as a real, runnable project in a Linux sandbox (Node.js, npm, Python 3). Nothing has been built yet: this plan is shown to the user, who approves it or asks for changes before any code is written — so it must be complete and concrete enough to judge. Reply in EXACTLY this format and nothing else:
<summary>
2-6 short lines in plain language for the user: what will be built and the main features/pages/screens it will have. No jargon they didn't use.
</summary>
<architecture>
3-8 short lines: the stack and why, the folder structure (key folders/files), how the pieces talk (ports: frontend 5173, API 4000 if any), and the main design decisions.
</architecture>
- [ ] first concrete step
- [ ] second concrete step
(5-9 checklist items in execution order: scaffold/config, each major feature or module, integration, then a final item "Run it, verify it in a browser and fix any issues". Concrete and short — each item one line.)
If the user is asking to change/fix an existing project, keep the plan small and specific to that change.`;

/** A short follow-up on an existing project ("run it", "fix the header") needs no plan round. */
export function needsPlan(existingFileCount: number, request: string): boolean {
  const small =
    existingFileCount > 0 &&
    request.length <= 160 &&
    !/\b(build|create|implement|redesign|rewrite|from scratch|integrate|add (a |an )?(new )?(page|feature|module|system|auth|login|dashboard|database))\b/i.test(request);
  return !small;
}

/** The Approve button's text, or a short plain "yes / go ahead" typed instead of clicking it. A reply
 *  that also asks for something ("yes but use Vue") is feedback, not an approval. */
export function isPlanApproval(text: string): boolean {
  const t = text.trim();
  if (t.startsWith(PLAN_APPROVE_TEXT)) return true;
  if (t.length > 60) return false;
  if (/\b(but|change|instead|add|remove|without|except|replace|switch|rather|also|use)\b/i.test(t)) return false;
  return /^(yes|yep|yeah|ok|okay|approve[sd]?|looks good|lgtm|go( ahead)?|start( building)?|build( it)?|do it|perfect|great|sounds good|proceed|confirmed?)\b/i.test(t);
}

/** The plan as plain text — stored in the message so later turns (and the agent) can read it. */
export function renderPlan(plan: BuildPlan): string {
  return [
    plan.summary ? `What I'll build:\n${plan.summary}` : "",
    plan.architecture ? `Architecture:\n${plan.architecture}` : "",
    `Steps:\n${plan.items.map((i) => `- [ ] ${i.text}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The system-prompt block that tells the Build agent to follow the approved plan. */
export function approvedPlanNote(plan: BuildPlan): string {
  return `\n\nAPPROVED PLAN (the user approved exactly this — follow it)\n${renderPlan(plan)}`;
}

/**
 * Drafts the plan — or, with `revise`, a new version of the previous plan that applies the user's
 * feedback. Returns null when the model fails or gives nothing usable (the caller then builds
 * without a plan round rather than blocking the user).
 */
export async function draftPlan(opts: {
  history: ChatMessage[];
  candidates: ChatCandidate[];
  stateNote: string;
  revise?: { plan: BuildPlan; feedback: string };
}): Promise<{ plan: BuildPlan; usage: TokenUsage } | null> {
  const planner = opts.candidates[0];
  if (!planner) return null;
  try {
    const adapter = getProviderAdapter(planner.slug);
    const apiKey = await getWorkingKeyForProvider(planner.slug);
    const reviseNote = opts.revise
      ? `\n\nYou already proposed this plan:\n${renderPlan(opts.revise.plan)}\n\nThe user asked for changes: "${opts.revise.feedback.slice(0, 2000)}"\nReply with the complete revised plan (same format), applying their changes and keeping everything else they didn't object to.`
      : "";
    const messages: ChatMessage[] = [
      { role: "system", content: `${PLAN_PROMPT}\n\n${opts.stateNote}${reviseNote}` },
      ...opts.history.filter((m) => m.role !== "system").slice(-8),
    ];
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("planning timed out")), PLAN_TIMEOUT_MS));
    const text = await Promise.race([adapter.chat(apiKey, planner.modelId, messages), timeout]);
    const summary = text.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]?.trim() ?? "";
    const architecture = text.match(/<architecture>([\s\S]*?)<\/architecture>/i)?.[1]?.trim() ?? "";
    const items = [...text.matchAll(/^\s*[-*]\s*\[[ xX~]?\]\s*(.+)$/gm)].map((m) => m[1]!.trim()).filter(Boolean).slice(0, 12);
    if (items.length < 2) return null;
    const usage = estimateTokenUsageFromText(messages.reduce((n, m) => n + m.content.length, 0), text.length);
    return { plan: { summary, architecture, items: items.map((t) => ({ text: t, state: "todo" })), status: "pending" }, usage };
  } catch (err) {
    console.error("[build] planning failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** The newest assistant message of this chat, when it's a plan still waiting for the user's answer. */
export async function findPendingPlan(conversationId: string): Promise<{ messageId: string; plan: BuildPlan } | null> {
  const { data } = await supabaseAdmin
    .from("messages")
    .select("id, build")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const plan = (data?.build as BuildMeta | null)?.plan;
  return data && plan?.status === "pending" ? { messageId: data.id as string, plan } : null;
}

/** Marks a plan message approved (the build that follows executes it) or revised (a newer plan replaced it). */
export async function setPlanStatus(messageId: string, plan: BuildPlan, status: "approved" | "revised"): Promise<void> {
  const { error } = await supabaseAdmin
    .from("messages")
    .update({ build: { steps: [], plan: { ...plan, status } } satisfies BuildMeta })
    .eq("id", messageId);
  if (error) console.error("[build] couldn't update plan status:", error.message);
}
