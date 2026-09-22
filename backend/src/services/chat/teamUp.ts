import { getProviderAdapter } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { getWorkingKeyForProvider, listChatCandidates, type ChatCandidate } from "../providerService.js";
import { pickStrongest } from "../modelRouting.js";
import type { WebSearchResult } from "../webSearch.js";
import { callCandidate, pickDistinctProviders, TEAMUP_MAX_MODELS } from "./candidates.js";
import { insertAssistantMessage } from "./conversations.js";
import { searchResultsToSystemMessage } from "./promptContext.js";
import type { StreamEvent } from "./types.js";
import { supabaseAdmin } from "../../config/supabase.js";

const SYNTHESIS_SYSTEM_PROMPT =
  "You are given the original request and several draft answers from different AI models. Write ONE final " +
  "answer that combines their strongest parts, resolves any disagreements between them, and corrects anything " +
  "wrong or weak in any draft. Answer as if you were asked directly — don't mention the drafts, the other " +
  "models, or that this is a synthesis. Structure the final answer for readability: short paragraphs, a " +
  "bulleted/numbered markdown list for multi-part answers, and markdown bold for section titles or key terms.";

/** Mixture-of-agents: merges Team Up's parallel drafts into a single best final answer. */
function buildSynthesisMessages(
  originalMessage: string,
  drafts: { candidate: ChatCandidate; text: string }[],
  grounding: ChatMessage[] = [],
): ChatMessage[] {
  const draftsBlock = drafts
    .map((d, i) => `Draft ${i + 1} (${d.candidate.displayName}):\n${d.text}`)
    .join("\n\n---\n\n");
  return [
    ...grounding,
    { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
    { role: "user", content: `Original request:\n${originalMessage}\n\n${draftsBlock}` },
  ];
}

/**
 * Team Up's streaming path: runs proposers concurrently, emitting an `agent` event as each one
 * starts/finishes/fails so the client can render a live "council" list, then streams the
 * synthesizer's merged final answer token-by-token exactly like a single model reply.
 */
export async function streamTeamUp(
  conversationId: string,
  content: string,
  history: ChatMessage[],
  searchResults: WebSearchResult[],
  webSearch: boolean,
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal,
  options: { think?: boolean; canvas?: boolean } = {},
): Promise<void> {
  const pool = await listChatCandidates();
  const proposers = pickDistinctProviders(pool, TEAMUP_MAX_MODELS);
  if (proposers.length === 0) {
    onEvent({ t: "err", c: "No chat models are enabled yet" });
    onEvent({ t: "done" });
    return;
  }

  onEvent({ t: "status", s: "thinking" });
  const agents: { slug: string; model: string; state: "start" | "done" | "error"; error?: string }[] = [];

  const settled = await Promise.all(
    proposers.map(async (candidate) => {
      const started = { slug: candidate.slug, model: candidate.displayName, state: "start" as const };
      agents.push(started);
      onEvent({ t: "agent", ...started });
      try {
        const text = await callCandidate(candidate, history);
        const done = { slug: candidate.slug, model: candidate.displayName, state: "done" as const };
        agents.push(done);
        onEvent({ t: "agent", ...done });
        return { candidate, text };
      } catch (err) {
        const failed = {
          slug: candidate.slug,
          model: candidate.displayName,
          state: "error" as const,
          error: err instanceof Error ? err.message : "failed",
        };
        agents.push(failed);
        onEvent({ t: "agent", ...failed });
        return null;
      }
    }),
  );
  const drafts = settled.filter((d): d is { candidate: ChatCandidate; text: string } => d !== null);

  if (drafts.length === 0) {
    onEvent({ t: "err", c: "Every model in the team failed to respond" });
    onEvent({ t: "done" });
    return;
  }

  let finalCandidate: ChatCandidate;
  let full: string;
  let thinking = "";

  if (drafts.length === 1) {
    // Nothing to synthesize against — the lone draft just is the final answer.
    finalCandidate = drafts[0]!.candidate;
    full = drafts[0]!.text;
    onEvent({ t: "text", c: full });
  } else {
    onEvent({ t: "status", s: "synthesizing" });
    finalCandidate = pickStrongest(pool);
    const grounding = webSearch ? [searchResultsToSystemMessage(searchResults)] : [];
    const synthMessages = buildSynthesisMessages(content, drafts, grounding);
    const adapter = getProviderAdapter(finalCandidate.slug);
    const apiKey = await getWorkingKeyForProvider(finalCandidate.slug);
    if (adapter.chatStream) {
      full = await adapter.chatStream(
        apiKey,
        finalCandidate.modelId,
        synthMessages,
        (delta) => onEvent({ t: "text", c: delta }),
        signal,
        (think) => {
          thinking += think;
          onEvent({ t: "think", c: think });
        },
      );
    } else {
      full = await adapter.chat(apiKey, finalCandidate.modelId, synthMessages);
      onEvent({ t: "text", c: full });
    }
  }

  const label = drafts.length > 1 ? `Team → ${finalCandidate.displayName}` : finalCandidate.displayName;
  await insertAssistantMessage(conversationId, full, label, {
    thinking,
    citations: searchResults.map((result) => ({ url: result.url, title: result.title })),
    agents,
    usedThink: options.think || Boolean(thinking),
    usedSearch: webSearch,
    usedCanvas: options.canvas ?? false,
  });
  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  onEvent({ t: "done" });
}
