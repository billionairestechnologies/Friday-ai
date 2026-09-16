import { getProviderAdapter } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { getWorkingKeyForProvider, listChatCandidates } from "../providerService.js";
import { rankCandidatesForMessage } from "../modelRouting.js";

/**
 * Auto-search intent detection — self-contained on purpose. If this doesn't work out, delete this
 * file and its one call site in index.ts (the `effectiveWebSearch` block), and the Search toggle
 * goes back to being purely manual with no other cleanup needed.
 *
 * A fixed keyword list ("today", "latest", "price"...) can't generalize to how people actually
 * phrase things — confirmed live: a user asked about Nifty's closing price with no such keyword
 * and got "I don't have live data" even though Search exists, just wasn't toggled on. Instead,
 * this asks a model to classify intent directly: does answering THIS message accurately need
 * current/live information? One small, fast, non-streamed YES/NO completion, only when the user
 * hasn't already toggled Search on — the real reply's model/latency is unaffected either way.
 */

const INTENT_SYSTEM_PROMPT =
  "Answer with exactly one word, YES or NO — nothing else, no punctuation, no explanation. Does " +
  "answering the user's message accurately require current, live, or real-time information — " +
  "today's date-dependent facts, current prices/scores/odds, live weather, breaking news, or " +
  "anything that may have changed since a model's training data? A general, timeless, " +
  "conceptual, or purely conversational message is NO.";

/** True if the model judges this message needs live info. Never throws — a failed probe just
 *  means no auto-search this turn, not a broken send. */
export async function detectNeedsLiveSearch(content: string): Promise<boolean> {
  try {
    const candidates = rankCandidatesForMessage(await listChatCandidates(), content);
    const candidate = candidates[0];
    if (!candidate) return false;

    const adapter = getProviderAdapter(candidate.slug);
    const apiKey = await getWorkingKeyForProvider(candidate.slug);
    const probe: ChatMessage[] = [
      { role: "system", content: INTENT_SYSTEM_PROMPT },
      { role: "user", content },
    ];
    const raw = await adapter.chat(apiKey, candidate.modelId, probe);
    return /^\s*yes/i.test(raw);
  } catch {
    return false;
  }
}
