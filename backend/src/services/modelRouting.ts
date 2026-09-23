import type { ChatCandidate } from "./providerService.js";

type ModelTag = "code" | "reasoning" | "multilingual" | "long-context" | "general";

interface ModelProfile {
  tags: ModelTag[];
  /** Rough overall capability tier (1-5), used both as a routing tiebreaker and to pick a Team Up synthesizer. */
  power: number;
}

// Keyword → profile, matched against "slug/model_id" lowercased. Order matters — first match wins,
// so put more specific patterns first. Anything unmatched falls back to a safe general-purpose profile.
const PROFILE_RULES: { pattern: RegExp; profile: ModelProfile }[] = [
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

function detectTags(message: string): ModelTag[] {
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
