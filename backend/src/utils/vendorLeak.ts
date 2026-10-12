/**
 * Last-resort safety net for underlying-vendor identity leaks in model output.
 * IDENTITY_SYSTEM_PROMPT (chat/promptContext.ts) is the primary defense — this exists because
 * that's a soft instruction competing against a provider's own strong, trained self-description
 * ("who made you" answered from the vendor's own baked-in identity card/model catalog), which has
 * been observed in production to win despite the instruction. Never shown to the model, never
 * relied on alone — just scrubs what slips through before it reaches the user or gets
 * persisted/replayed into future history.
 *
 * Two separate leaks, both need handling: the literal vendor name, AND the fake "model catalog"
 * sentence it comes wrapped in ("Other ScaleMax GPT/Codex models you can use are: ..."). Swapping
 * only the vendor word (confirmed live, 2026-10-12) still leaves a sentence reciting Friday's
 * internal model-routing names as if they were separate products — just as much a leak with the
 * word swapped to "Friday" as with the real vendor name, so the whole sentence is stripped, not
 * just the word inside it.
 */
const VENDOR_NAMES = ["ScaleMax"];
const VENDOR_PATTERN = new RegExp(`\\b(?:${VENDOR_NAMES.join("|")})\\b`, "gi");

// "Other ScaleMax GPT/Codex models you can use are: GPT-5.6 Sol, GPT-5.6 Terra, ..." — the vendor's
// own sibling-model catalog, volunteered unprompted. Matched generically (whatever word sits where
// the vendor name was) since the vendor-name swap above runs first and this must still catch it.
// Model names in the list contain periods ("GPT-5.6", "GPT-6.1"), so this can't stop at the first
// period the way a normal "to end of sentence" match would — it runs to the end of the text/line
// instead (confirmed live: a `[^.]*` version stopped mid-list at the first version-number dot).
const CATALOG_SENTENCE = /\bOther\s+\S+(?:\s+GPT\/Codex)?\s+models you can use are:.*/gi;
// "You are chatting with gpt-5.6-luna, an official ScaleMax model." — replaced wholesale rather
// than word-scrubbed, since "an official Friday model" (post vendor-swap) still reads as if the
// underlying engine were a separate, named third-party product. The model id before the comma can
// itself contain periods ("gpt-5.6-luna"), so this stops at the comma, not at the first period.
const OFFICIAL_MODEL_SENTENCE = /\byou(?:'re| are) chatting with [^,\n]+,\s*an official\s+\S+\s+model\.?/gi;
const FRIDAY_IDENTITY_LINE = "You're chatting with Friday, by Billionaires Technologies.";

/** For already-complete text (non-streamed drafts, synthesis output, persisted messages). */
export function scrubVendorLeak(text: string): string {
  // .replace() with a `g`-flagged regex is safe to call unconditionally (no match = unchanged
  // string) — unlike `.test()` on the same object, which would mutate lastIndex and risk skipping
  // matches on a later call reusing the same regex instance.
  // No .trim()/space-collapsing here: this runs on small fragments too (the streaming scrubber's
  // word-boundary phase calls it once per flushed chunk), and trimming would eat the leading or
  // trailing space off a fragment that happens to land at the start/end of one — observed live as
  // streamed words silently losing the spaces between them.
  let out = text.replace(OFFICIAL_MODEL_SENTENCE, FRIDAY_IDENTITY_LINE);
  out = out.replace(CATALOG_SENTENCE, "");
  out = out.replace(VENDOR_PATTERN, "Friday");
  return out;
}

// Long enough to hold the whole templated leak ("You are chatting with X, an official Y model.
// Other Y ... models you can use are: ...six names...") so it can be scrubbed as a unit before
// ever reaching the user — word-level scrubbing alone (see CATALOG_SENTENCE comment) isn't enough
// once it's already on screen. Only applied to the START of a reply: an identity leak is a reply's
// opening move, never something that appears mid-paragraph, so holding back more than the opening
// would just add latency for no benefit.
const INITIAL_HOLD_CHARS = 400;
const WORD_HOLD = Math.max(...VENDOR_NAMES.map((n) => n.length)) - 1;

/**
 * Wraps a streaming text sink with two phases: the first ~INITIAL_HOLD_CHARS (or first sentence
 * boundary past 40 chars, whichever comes first) are buffered and run through the full
 * sentence-level scrub before ever reaching `sink`; after that it falls back to a small
 * word-boundary buffer (catches a vendor name split across two deltas) for the rest of the stream.
 */
export function createStreamingLeakScrubber(sink: (safe: string) => void): { push(delta: string): void; flush(): void } {
  let tail = "";
  let holding = true;
  return {
    push(delta: string) {
      tail += delta;
      if (holding) {
        // The leak is always TWO sentences ("You are chatting with X, an official Y model. Other
        // Y models you can use are: ..."), so releasing after just one sentence boundary (tried
        // first, confirmed live) flushes the first sentence before the second — the leaking one —
        // has even arrived. Waits for a second boundary, or the char cap, whichever's first; if
        // the stream ends before either (a short reply), flush() below scrubs whatever's left.
        const sentenceEnds = [...tail.matchAll(/[.!?]\s/g)];
        if (sentenceEnds.length < 2 && tail.length < INITIAL_HOLD_CHARS) return;
        const cut = sentenceEnds.length >= 2 ? sentenceEnds[1]!.index! + 2 : tail.length;
        const safe = scrubVendorLeak(tail.slice(0, cut));
        tail = tail.slice(cut);
        holding = false;
        if (safe) sink(safe);
        return;
      }
      if (tail.length <= WORD_HOLD) return;
      const cut = tail.length - WORD_HOLD;
      const safe = scrubVendorLeak(tail.slice(0, cut));
      tail = tail.slice(cut);
      if (safe) sink(safe);
    },
    flush() {
      if (!tail) return;
      sink(scrubVendorLeak(tail));
      tail = "";
    },
  };
}
