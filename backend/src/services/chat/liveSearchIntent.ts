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
 *  means no auto-search this turn, not a broken send.
 *
 *  This runs before the real reply on every message that doesn't already have Search toggled on,
 *  so it must never be the thing making replies feel slow. Some provider adapters (ScaleMax in
 *  particular) have no fetch timeout of their own, and rankCandidatesForMessage can pick any
 *  enabled provider as the probe — without a bound here, one slow/hanging provider silently adds
 *  its full hang time to every single message's latency, not just its own. Confirmed live
 *  (2026-09-22) as the dominant cause of "every model feels slow to reply." */
const INTENT_PROBE_TIMEOUT_MS = 1500;

/**
 * Cheap pre-check that lets the probe be SKIPPED — it costs ~2s on the critical path of every reply,
 * which is the single biggest avoidable delay before the first token. The probe (a model's judgment)
 * still decides every information-seeking question; only messages that are plainly a task rather than
 * a question about the world are waved through: code, writing/rewriting/translating/explaining
 * requests, chit-chat — and only when they carry none of the words that hint at live data. Anything
 * ambiguous still goes to the model.
 */
const LIVE_HINTS =
  /\b(today|tonight|now|current(ly)?|latest|recent(ly)?|news|price|prices|stock|stocks|share|weather|forecast|score|scores|live|update[sd]?|yesterday|tomorrow|this (week|month|year|season)|20[2-9]\d|trending|release[sd]?|version|market|nifty|sensex|bitcoin|crypto|rate|election|match|result|results|ceo|president|prime minister|who (is|won|are)|when (is|does|did)|how much|status|open|closing|winner|standings|ranking|earnings|ipo)\b/i;
const TASK_LIKE =
  /^(write|rewrite|draft|compose|translate|summari[sz]e|explain|fix|debug|refactor|implement|generate|create|make|build|design|convert|format|improve|proofread|paraphrase|brainstorm|list|give me (an? )?(example|idea|summary)|show me (an? )?example|help me (write|draft|understand|with))\b/i;

export function shouldProbeForLiveSearch(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  if (LIVE_HINTS.test(text)) return true;
  if (text.includes("```") || text.split("\n").length > 6) return false; // code / long pasted material
  if (TASK_LIKE.test(text)) return false;
  if (text.length < 25 && !/\?/.test(text)) return false; // greetings, acknowledgements
  return true;
}

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
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("intent probe timed out")), INTENT_PROBE_TIMEOUT_MS),
    );
    const raw = await Promise.race([adapter.chat(apiKey, candidate.modelId, probe), timeout]);
    return /^\s*yes/i.test(raw);
  } catch {
    return false;
  }
}
