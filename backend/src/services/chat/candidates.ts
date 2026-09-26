import { getProviderAdapter } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { getWorkingKeyForProvider, type ChatCandidate } from "../providerService.js";
import { detectTags } from "../modelRouting.js";

// Team Up fans a message out to at most this many distinct providers, one model each, by default —
// so an ordinary message doesn't burn through every configured key at once. teamUpProposerCount()
// below can raise this per-message when the message itself calls for more breadth.
export const TEAMUP_MAX_MODELS = 3;
// Absolute ceiling regardless of how many providers are enabled or how strong the signal is —
// protects latency (every proposer runs in parallel, but the slowest one still gates the reply)
// and cost (every proposer is a full, separately-billed model call).
export const TEAMUP_HARD_CAP = 6;

// "use 4 models", "ask 5 different models", "compare 3 models" — an explicit count the user typed.
const EXPLICIT_COUNT = /\b(?:use|ask|get(?: answers?)?|poll|compare|try)\s+(\d{1,2})\s+(?:different\s+)?models?\b/i;
// "ask all models", "use every model" — as many distinct providers as are actually enabled.
const EXPLICIT_ALL = /\b(?:use|ask|try)\s+(?:all|every)(?:\s+the)?\s+models?\b|\ball(?:\s+the)?\s+models?\b/i;
// Language that signals the user wants breadth/consensus, not just one model's take.
const BREADTH_HINTS =
  /\b(compare|pros and cons|different (angles|approaches|opinions|perspectives)|second opinion|multiple (opinions|viewpoints|models)|debate|comprehensive|in[- ]depth|thorough|deep dive|every angle|cross[- ]check|get consensus)\b/i;
const NUMBERED_LIST_ITEM = /(?:^|\n)\s*(?:[-*]|\d+[.)])\s+\S/g;
const LONG_MESSAGE_CHARS = 600;

/**
 * How many distinct providers Team Up should fan a message out to. Stays at the historical default
 * (TEAMUP_MAX_MODELS) for an ordinary message — this only ever adds MORE models when the message
 * itself signals it needs the breadth: an explicit "use N models" / "ask all models", comparison
 * or thoroughness language, several distinct routing-tag signals at once (e.g. both code AND
 * reasoning — a genuinely harder ask), or a message already broken into several numbered/bulleted
 * parts. Never exceeds TEAMUP_HARD_CAP, and never exceeds however many distinct providers are
 * actually enabled with a working key (there is nothing to gain past that).
 */
export function teamUpProposerCount(pool: ChatCandidate[], message: string): number {
  const distinctProviders = new Set(pool.map((c) => c.slug)).size;
  const cap = Math.min(TEAMUP_HARD_CAP, distinctProviders);
  if (cap <= TEAMUP_MAX_MODELS) return cap; // not enough distinct providers enabled for this to matter

  if (EXPLICIT_ALL.test(message)) return cap;
  const explicit = message.match(EXPLICIT_COUNT);
  if (explicit) {
    const n = Number(explicit[1]);
    if (Number.isFinite(n) && n >= 2) return Math.min(cap, n);
  }

  let score = 0;
  if (BREADTH_HINTS.test(message)) score++;
  if (message.length > LONG_MESSAGE_CHARS) score++;
  if (detectTags(message).length >= 2) score++; // e.g. code AND reasoning both present
  if ((message.match(NUMBERED_LIST_ITEM)?.length ?? 0) >= 3) score++; // already broken into several parts

  return Math.min(cap, TEAMUP_MAX_MODELS + score);
}

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

/**
 * Picks distinct providers so Team Up compares different vendors rather than two models from one.
 *
 * When `requiresVision` is set (the turn has an image that needs real vision, not just OCR text),
 * only vision-capable candidates are eligible — otherwise Team Up could silently fan an image out
 * to proposers that can't see it at all, producing blind drafts with no error shown (mirrors the
 * gate single/auto mode apply; see modelRouting.ts).
 */
export function pickDistinctProviders(candidates: ChatCandidate[], limit: number, requiresVision = false): ChatCandidate[] {
  const pool = requiresVision ? candidates.filter((c) => c.vision) : candidates;
  const seen = new Set<string>();
  const picked: ChatCandidate[] = [];
  for (const c of pool) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    picked.push(c);
    if (picked.length >= limit) break;
  }
  return picked;
}
