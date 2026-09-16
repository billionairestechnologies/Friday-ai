import { getProviderAdapter } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { getWorkingKeyForProvider, type ChatCandidate } from "../providerService.js";

// Team Up fans a message out to at most this many distinct providers, one model each,
// so a single send doesn't burn through every configured key at once.
export const TEAMUP_MAX_MODELS = 3;

// adapter.chat() has no abort signal, so a slow/stuck provider (a local Ollama model with no
// GPU, a network stall) can hang a fetch indefinitely. That's fatal for Auto/Team Up, which wait
// on multiple candidates — one hung candidate blocks the whole reply forever with no error shown.
// This bounds every non-streaming call so a stuck candidate fails instead of hanging the request.
//
// Confirmed in production (2026-09-16): Team Up proposers and the synthesis call are always
// non-streaming (callCandidate), and a reasoning ("Think") model working over a long context can
// easily run past a minute before it has anything to return. At 45s that reads as every proposer
// erroring out ("Every model in the team failed to respond") — indistinguishable from the whole
// feature randomly dying mid-thought. 45s was tuned for a stuck/hung connection, not a slow-but-
// working one; raised well above realistic Think/long-context latency so it only fires on an
// actually-dead request.
const CANDIDATE_TIMEOUT_MS = 150_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const id = setTimeout(() => reject(new Error(`${label} took too long to respond`)), ms);
      // NOT `promise.finally(...)`: `.finally()` returns a new derived promise that re-throws
      // the original rejection, and nothing here holds onto or awaits that derived promise. If
      // `promise` rejects after this race has already settled via the timeout branch (a slow
      // provider that eventually errors — confirmed in production against a Cloudflare 524 from
      // ScaleMax), that orphaned derived promise becomes an unhandled rejection and crashes the
      // whole Node process, taking down every other in-flight request with it. `.then` with both
      // handlers clears the timer without producing a floating rejection.
      promise.then(
        () => clearTimeout(id),
        () => clearTimeout(id),
      );
    }),
  ]);
}

export async function callCandidate(candidate: ChatCandidate, history: ChatMessage[]): Promise<string> {
  const adapter = getProviderAdapter(candidate.slug);
  const apiKey = await getWorkingKeyForProvider(candidate.slug);
  return withTimeout(adapter.chat(apiKey, candidate.modelId, history), CANDIDATE_TIMEOUT_MS, candidate.slug);
}

/** Picks distinct providers so Team Up compares different vendors rather than two models from one. */
export function pickDistinctProviders(candidates: ChatCandidate[], limit: number): ChatCandidate[] {
  const seen = new Set<string>();
  const picked: ChatCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    picked.push(c);
    if (picked.length >= limit) break;
  }
  return picked;
}
