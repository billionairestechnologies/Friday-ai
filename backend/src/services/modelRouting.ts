import type { ChatCandidate } from "./providerService.js";

type ModelTag = "code" | "reasoning" | "multilingual" | "long-context" | "general";

interface ModelProfile {
  tags: ModelTag[];
  /** Time-to-first-token class (1 slow … 5 fast). Measured against the live catalog, not guessed:
   *  gpt-5.6-luna / gpt-5.4-mini ≈1.6s, gpt-5.5 / terra ≈2.2s, sonnet / fable ≈3s+, opus / sol / astra 3-4s+. */
  speed?: number;
  /** Rough overall capability tier (1-5), used both as a routing tiebreaker and to pick a Team Up synthesizer. */
  power: number;
}

// Keyword → profile, matched against "slug/model_id" lowercased. Order matters — first match wins,
// so put more specific patterns first. Anything unmatched falls back to a safe general-purpose profile.
const PROFILE_RULES: { pattern: RegExp; profile: ModelProfile }[] = [
  { pattern: /gpt-5\.6-luna|mini|haiku|flash|nano|lite/, profile: { tags: ["general", "code"], power: 3, speed: 5 } },
  { pattern: /gpt-5\.6-terra|gpt-5\.5/, profile: { tags: ["reasoning", "code", "general"], power: 4, speed: 4 } },
  { pattern: /gpt-6|gpt-5\.6-sol/, profile: { tags: ["reasoning", "code"], power: 5, speed: 2 } },
  { pattern: /opus/, profile: { tags: ["reasoning", "code", "general"], power: 5 } },
  { pattern: /o[13](-|$)|gpt-5/, profile: { tags: ["reasoning", "code"], power: 5 } },
  { pattern: /sonnet/, profile: { tags: ["reasoning", "code", "general"], power: 4 } },
  { pattern: /gpt-4/, profile: { tags: ["reasoning", "code", "general"], power: 4 } },
  { pattern: /gemini.*pro/, profile: { tags: ["long-context", "reasoning", "general"], power: 4 } },
  { pattern: /gemini/, profile: { tags: ["long-context", "general"], power: 3 } },
  { pattern: /fable/, profile: { tags: ["general"], power: 3 } },
  { pattern: /sarvam/, profile: { tags: ["multilingual", "general"], power: 2 } },
  { pattern: /.*/, profile: { tags: ["general"], power: 2 } },
];

function profileFor(candidate: ChatCandidate): ModelProfile {
  const key = `${candidate.slug}/${candidate.modelId}`.toLowerCase();
  return PROFILE_RULES.find((r) => r.pattern.test(key))!.profile;
}

// Devanagari, Bengali, Tamil, Telugu, Gujarati, Gurmukhi, Kannada, Malayalam, Odia — enough to catch
// most Indic-script messages that Sarvam is tuned for.
const INDIC_SCRIPT = /[ऀ-ॿঀ-৿஀-௿ఀ-౿઀-૿਀-੿ಀ-೿ഀ-ൿ଀-୿]/;
const CODE_HINTS = /```|`[^`]+`|\b(function|const |let |class |def |import |select |from |=>|npm |pip install)\b/i;
const REASONING_HINTS = /\b(solve|prove|calculate|step by step|equation|derivative|integral|algorithm|why does|explain how)\b/i;
const LONG_INPUT_CHARS = 4000;

export function detectTags(message: string): ModelTag[] {
  const tags: ModelTag[] = [];
  if (INDIC_SCRIPT.test(message)) tags.push("multilingual");
  if (CODE_HINTS.test(message)) tags.push("code");
  if (REASONING_HINTS.test(message)) tags.push("reasoning");
  if (message.length > LONG_INPUT_CHARS) tags.push("long-context");
  return tags;
}

function score(candidate: ChatCandidate, tags: ModelTag[]): number {
  const profile = profileFor(candidate);
  let s = profile.power;
  for (const t of tags) if (profile.tags.includes(t)) s += 3;
  return s;
}

/**
 * Reorders Auto-mode candidates so the model best suited to THIS message (based on lightweight
 * text heuristics — code, reasoning, Indic-script, long input) is tried first, instead of a fixed
 * order. Falls through the rest exactly as before if the top pick fails, so reliability doesn't regress.
 *
 * When the message has an image attachment that needs real vision (i.e. wasn't already covered by
 * OCR/text extraction), non-vision candidates are dropped entirely rather than just deprioritized —
 * a non-vision model silently answering without ever seeing the image is worse than trying fewer,
 * correct candidates. Mirrors the explicit gate single-mode already has (chat/index.ts), which Auto
 * mode was missing.
 */
export function rankCandidatesForMessage(
  candidates: ChatCandidate[],
  message: string,
  requiresVision = false,
): ChatCandidate[] {
  const tags = detectTags(message);
  const pool = requiresVision ? candidates.filter((c) => c.vision) : candidates;
  // A short, plain message (no code / reasoning / long-context signals) doesn't need the most powerful
  // model — and the most powerful ones are also the slowest to start answering. For those, rank by how
  // fast the model starts (then power as a tiebreaker) so the reply begins sooner. Anything that looks
  // like real work keeps the capability-first ordering.
  const simple = tags.length === 0 && message.length < 500;
  if (simple) {
    return [...pool].sort(
      (a, b) => (profileFor(b).speed ?? 3) - (profileFor(a).speed ?? 3) || profileFor(b).power - profileFor(a).power,
    );
  }
  return [...pool].sort((a, b) => score(b, tags) - score(a, tags));
}

/**
 * Picks the highest general-capability model from a pool — used as the Team Up synthesizer.
 * When `requiresVision` is set, only vision-capable candidates are eligible (the synthesizer
 * gets the raw image re-attached alongside the proposers' text drafts — see teamUp.ts — so it
 * needs to actually be able to see it, not just read what the proposers said about it).
 */
export function pickStrongest(candidates: ChatCandidate[], requiresVision = false): ChatCandidate {
  const pool = requiresVision ? candidates.filter((c) => c.vision) : candidates;
  const ranked = pool.length > 0 ? pool : candidates;
  return [...ranked].sort((a, b) => profileFor(b).power - profileFor(a).power)[0]!;
}
