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

const MAX_IMAGE_REQUEST_CHARS = 600;
const GENERATE_VERB_NEAR_NOUN = new RegExp(`${GENERATE_VERB.source}\\b[^.\\n]{0,40}?${IMAGE_NOUN.source}`, "i");

export type ImageIntent = { kind: "generate"; prompt: string } | { kind: "edit"; prompt: string } | null;

export function detectImageIntent(message: string, hasImageAttachment: boolean): ImageIntent {
  const text = message.trim();
  if (!text) return null;

  // EDIT_PHRASE explicitly names "this/that/the image" as the thing being changed, so it's
  // unambiguous even with no fresh attachment on this message ("make the image darker" after an
  // earlier generated image) — the caller resolves which image from conversation history. Confirmed
  // live: without this, that wording fell through to GENERATE_VERB_NEAR_NOUN below (it also matches
  // a generate verb near "image") and produced a brand-new, unrelated image instead of an edit.
  // EDIT_VERB alone ("recolor it", "retouch") has no image noun, so it stays gated on an actual
  // attachment to avoid false positives on ordinary text ("transform this paragraph").
  if (EDIT_PHRASE.test(text) || (hasImageAttachment && EDIT_VERB.test(text))) {
    return { kind: "edit", prompt: text };
  }

  // An image request is a short ask ("draw a logo for my cafe"). A long brief that happens to contain
  // "design" and "icons" somewhere (a landing-page spec) must reach the normal chat / Build path, and
  // the verb has to sit right before the noun, not anywhere in the message.
  if (text.length <= MAX_IMAGE_REQUEST_CHARS && GENERATE_VERB_NEAR_NOUN.test(text)) {
    return { kind: "generate", prompt: text };
  }

  return null;
}

// Recognizes "the last assistant turn was a real generated image" without needing a separate DB
// column, by reading the same conversation history already fetched for the prompt. Matches either
// the caption index.ts prepends on the regex-shortcut path, OR a bare `![...]()` markdown image
// anywhere in the reply — the generate_image TOOL path (agent/tools/image.ts, used in the normal
// tool-loop turn) writes the image with no caption at all, so requiring the caption missed every
// tool-generated image and silently dropped short corrections ("no, make it blue") that followed one.
const GENERATED_IMAGE_REPLY = /^(Here you go:|Here's the edited image:)|!\[[^\]]*\]\(https?:\/\/[^)\s]+\)/;

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

// Confirmed live in production (2026-10-18): length alone isn't enough. After a generated image,
// "type big story" was sent to the image editor, and so was any short document ask ("make it a
// pdf"). Failed image turns are dropped from history, so the image stayed the "last reply" and
// EVERY later short message was hijacked the same way — the chat looked stuck. A correction now
// has to talk about the picture (a visual change, a colour, or "I said/told you…"), and a message
// that names a text/document task never counts.
const CORRECTION_CUE =
  /\b(make|change|turn|add|remove|replace|put|without|instead|more|less|bigger|smaller|brighter|darker|lighter|colou?rs?|background|style|redo|again|retry|wrong|told|said|asked|fix|red|blue|green|yellow|black|white|pink|purple|orange|gold|silver|gr[ae]y|brown)\b/i;
const TEXT_TASK =
  /\b(type|write|story|poem|essay|article|blog|explain|summari[sz]e|translate|code|script|email|letter|list|pdf|docx?|word|excel|xlsx|sheet|spreadsheet|pptx?|slides?|presentation|deck|document|report|csv|json|caption|tell me|what|why|how|who|when|where)\b/i;

export function looksLikeImageCorrection(message: string): boolean {
  const text = message.trim();
  return isShortEnoughForCorrection(text) && CORRECTION_CUE.test(text) && !TEXT_TASK.test(text);
}
