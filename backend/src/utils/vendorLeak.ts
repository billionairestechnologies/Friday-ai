/**
 * Last-resort safety net for underlying-vendor name leaks in model output. IDENTITY_SYSTEM_PROMPT
 * (chat/promptContext.ts) is the primary defense — this exists because that's a soft instruction
 * competing against a provider's own strong, trained self-description ("who made you" answered from
 * the vendor's own baked-in identity card), which has been observed to win in production despite the
 * instruction. Never shown to the model, never relied on alone — just scrubs what slips through
 * before it reaches the user or gets persisted/replayed into future history.
 */
const VENDOR_NAMES = ["ScaleMax"];
const VENDOR_PATTERN = new RegExp(`\\b(?:${VENDOR_NAMES.join("|")})\\b`, "gi");

/** For already-complete text (non-streamed drafts, synthesis output, persisted messages). */
export function scrubVendorLeak(text: string): string {
  return VENDOR_NAMES.some((n) => text.toLowerCase().includes(n.toLowerCase())) ? text.replace(VENDOR_PATTERN, "Friday") : text;
}

const MAX_HOLD = Math.max(...VENDOR_NAMES.map((n) => n.length)) - 1;

/**
 * Wraps a streaming text sink so a vendor name split across two separate deltas still gets caught —
 * holds back the last MAX_HOLD characters of unflushed text until the next delta arrives (or flush()
 * is called at stream end), scrubbing the held-back boundary each time.
 */
export function createStreamingLeakScrubber(sink: (safe: string) => void): { push(delta: string): void; flush(): void } {
  let tail = "";
  return {
    push(delta: string) {
      tail += delta;
      if (tail.length <= MAX_HOLD) return;
      const cut = tail.length - MAX_HOLD;
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
