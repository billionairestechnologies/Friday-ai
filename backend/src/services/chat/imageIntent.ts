// Detects "please make me an image" intent from the raw message text via cheap regexes —
// deliberately NOT an LLM classifier call. detectNeedsLiveSearch() used to be one of those and
// it silently added a full extra model round-trip's latency to every message (see [[project_
// chat_latency_and_formatting_fix]] in memory / the fix in liveSearchIntent.ts) — an image-intent
// classifier would repeat that mistake, and additionally risks a false positive spending real
// money on a paid image API. A regex is instant and, tuned conservatively (see comments below),
// a false negative just means the message goes through the normal text chat path — safe. A false
// positive would generate an image nobody asked for and bill the account, so this stays
// deliberately narrow rather than broad.

const GENERATE_VERB = /\b(draw|generate|create|make|design|paint|sketch|render|illustrate|produce)\b/i;
const IMAGE_NOUN = /\b(image|picture|photo|illustration|logo|icon|artwork|drawing|poster|wallpaper|avatar|portrait|painting|graphic|thumbnail|banner)\b/i;

// Deliberately excludes generic verbs like "change"/"add"/"remove" on their own — those false-
// positive constantly on ordinary text requests ("add a bullet point", "remove that line"). Only
// counts as edit intent when BOTH an image is attached AND the wording explicitly names the
// image/photo as the thing being acted on.
const EDIT_VERB = /\b(edit|recolor|re-?touch|colorize|photoshop|transform|restyle)\b/i;
const EDIT_PHRASE = /\b(edit|change|turn|make|colorize|recolor|re-?touch)\b.{0,30}\b(this|that|the)\s+(image|picture|photo)\b/i;

export type ImageIntent = { kind: "generate"; prompt: string } | { kind: "edit"; prompt: string } | null;

export function detectImageIntent(message: string, hasImageAttachment: boolean): ImageIntent {
  const text = message.trim();
  if (!text) return null;

  if (hasImageAttachment && (EDIT_VERB.test(text) || EDIT_PHRASE.test(text))) {
    return { kind: "edit", prompt: text };
  }

  if (GENERATE_VERB.test(text) && IMAGE_NOUN.test(text)) {
    return { kind: "generate", prompt: text };
  }

  return null;
}

// Exactly matches the caption index.ts prepends to a real generated/edited image's reply — used
// to recognize "the last assistant turn was a real generated image" without needing a separate DB
// column, by reading the same conversation history already fetched for the prompt.
const GENERATED_IMAGE_REPLY = /^(Here you go:|Here's the edited image:)/;

/**
 * Confirmed live in production (2026-09-23): a user got a wrong generated image back (asked for
 * "macbook on table", got an unrelated stock photo — a real prompt-adherence issue with the image
 * model, not a code bug), then sent a short correction ("I told you macbook on table") that
 * doesn't contain any generate/edit verb, so detectImageIntent() above returns null for it. With
 * IMAGE_HONESTY_SYSTEM_PROMPT now blocking the chat model from fabricating a fake replacement
 * image, that correction would otherwise just get a text-only "I can't tell this is about the
 * image" reply — technically honest, but not what the user needs, which is another attempt.
 *
 * This catches that specific case — SHORT-message-immediately-after-a-generated-image — and
 * retries as an edit of the previous (wrong) image using the new wording as the correction. The
 * length cap keeps this from firing on an unrelated new request that just happens to follow an
 * image reply (a real topic change is very unlikely to be this short) — false negatives here just
 * fall through to a normal chat reply (safe); a false positive would spend money on an unwanted
 * regeneration, which the length gate is specifically there to keep rare.
 */
const CORRECTION_MAX_CHARS = 80;

export function findImageCorrection(history: { role: string; content: string }[]): { priorPrompt: string; imageUrl: string } | null {
  let lastAssistantIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) return null;
  const lastReply = history[lastAssistantIdx]!.content.trim();
  if (!GENERATED_IMAGE_REPLY.test(lastReply)) return null;

  const urlMatch = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/.exec(lastReply);
  if (!urlMatch) return null;

  for (let j = lastAssistantIdx - 1; j >= 0; j--) {
    if (history[j]!.role === "user") {
      return { priorPrompt: history[j]!.content, imageUrl: urlMatch[1]! };
    }
  }
  return null;
}

export function isShortEnoughForCorrection(message: string): boolean {
  return message.trim().length > 0 && message.trim().length <= CORRECTION_MAX_CHARS;
}
