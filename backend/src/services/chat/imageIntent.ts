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
