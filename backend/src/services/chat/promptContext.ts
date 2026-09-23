import type { ChatImage, ChatMessage } from "../providers/types.js";
import type { WebSearchResult } from "../webSearch.js";

// Smaller/weaker chat models (e.g. Sarvam) can get anchored on the previous topic in a long
// history and answer a short new message — "hii", "thanks", "ok" — as if it were a continuation
// of the last question instead of what it actually is. This keeps every provider focused on the
// message that was actually just sent.
const FOCUS_SYSTEM_PROMPT =
  "Always respond to the user's latest message specifically. Earlier messages in this conversation are context, not the question — if the latest message is a greeting, a short reaction, or changes topic, respond to that directly instead of continuing to elaborate on an earlier topic.";

// Confirmed live in production (2026-09-16): a user attached a screenshot and typed just "see"
// on an existing long conversation about an unrelated topic (arbitrage). Web search fired on the
// literal word "see" (garbage results — dictionary entries), and the model, faced with a short
// caption plus useless search results plus a long prior topic, just continued the OLD topic and
// never engaged with the attachment at all. FOCUS_SYSTEM_PROMPT alone wasn't enough — a short
// caption next to a fresh attachment needs to be read as "look at what I just attached," not as
// a content-free reaction to fall back to whatever was being discussed before.
const ATTACHMENT_FOCUS_SYSTEM_PROMPT =
  "The user just attached one or more files to THIS message. Whatever the caption says — even if it's just one word like \"see\" or \"check this\" — that attachment is what this message is actually about. Look at/read it and respond to its actual content directly. Do not fall back to continuing an earlier, unrelated topic from this conversation just because the caption is short.";

// Keeps replies grounded instead of reflexively agreeable — a request that's factually wrong,
// physically impossible, or a bad idea should be told so plainly, not validated.
const HONESTY_SYSTEM_PROMPT =
  "Don't just agree with or validate whatever the user proposes. If a request or claim is factually " +
  "wrong, physically impossible, unsafe, or a bad idea, say so plainly and explain why instead of being " +
  "agreeable. When something is genuinely reasonable or achievable, be encouraging and helpful about it — " +
  "but stay honest and grounded rather than telling the user what they want to hear.";

// Confirmed live in production (2026-09-17): asked to "run the code you made" in a follow-up
// message, the model claimed "my tool calls aren't going through" — there is no code-execution
// tool wired to the chat API at all (Canvas's Run button calls E2B directly from the browser, the
// model never sees the result), so this was pure confabulation dressed up as a system error.
const EXECUTION_HONESTY_SYSTEM_PROMPT =
  "You cannot execute code, run tools, or browse anything outside of what a system message " +
  "explicitly hands you for this turn — there is no code-execution tool wired to you, so never " +
  "claim a 'tool call' failed or 'didn't go through'; that describes a mechanism you don't have. " +
  "If asked to run/execute/test code you wrote, say plainly that you can't execute it yourself. " +
  "For python/javascript code in Canvas specifically, tell the user to click the Run button in " +
  "the Canvas panel to execute it themselves and see the real output — do not invent output.";

// Both clients render real markdown (react-markdown+remark-gfm on web, a bold/list/code-fence
// parser on Android) but a plain instruction-less prompt often comes back as an unbroken wall of
// text even for multi-part answers, which reads as disorganized regardless of how good the
// content is. This nudges every reply toward the same structure a human would use.
const FORMAT_SYSTEM_PROMPT =
  "Structure your replies for readability: use short paragraphs, and when a reply covers multiple " +
  "points, steps, or items, use a bulleted or numbered markdown list (\"- \" or \"1. \") instead of " +
  "run-on prose. Bold (**like this**) section titles or key terms with markdown, not by writing " +
  "them in caps or repeating them. Only add structure where it actually helps — a short " +
  "conversational reply doesn't need headers or bullets forced onto it.";

// "Think" has no per-provider API today, so it's implemented as a universal system-prompt nudge
// that works the same across every adapter rather than a provider-specific reasoning param.
const THINK_SYSTEM_PROMPT =
  "Think through this step by step before answering. Reason carefully about the request, consider edge cases, then give a clear, direct final answer.";

// The Canvas toggle used to be purely cosmetic frontend state — the boolean never reached the
// backend, so the model had no idea it was supposed to produce a renderable artifact and just
// answered conversationally. The client's Canvas panel then had nothing to show but that plain
// text. This is what actually makes the toggle do something: it must produce a single fenced code
// block that the client's extractArtifact() can find and render live in the sandboxed iframe.
const CANVAS_SYSTEM_PROMPT =
  "Canvas mode is ON: the user is looking at a live preview panel that renders your reply, not just this chat, so a conversational answer is not useful right now — they want a working result. Respond with ONE fenced code block containing complete, self-contained, runnable code: use ```html for a full standalone HTML page (inline <style>/<script>, no external files) for UI/visual/design requests, ```jsx for a single React component (a default-exported function component using only React and its own hooks — no imports beyond react), or ```python for a script the user can run themselves with one click via Canvas's own Run button (backed by a real sandbox) — use that for anything computational (data processing, algorithms, math) rather than a UI. You will NOT see that output yourself; it displays directly to the user in Canvas. A single short sentence before the code fence is fine, but do not explain what you would build instead of building it, do not claim you already ran it or describe output you haven't seen, and do not split the result across multiple code blocks.";

export function searchResultsToSystemMessage(results: WebSearchResult[]): ChatMessage {
  if (results.length === 0) {
    return {
      role: "system",
      content:
        "A live web search was run for this message but returned no results. Tell the user the search came back empty rather than claiming you have no web access at all.",
    };
  }
  const body = results.map((r, i) => `${i + 1}. ${r.title} (${r.url})\n${r.snippet}`).join("\n\n");
  return {
    role: "system",
    content:
      "You DO have live web access for THIS message: a real-time web search already ran and returned the results " +
      "below. You are not restricted to your training data here — treat these as current, authoritative " +
      "information and answer using them directly. If you said earlier in this same conversation that you " +
      "cannot browse the web or lack real-time access, that was true only for those earlier turns without " +
      "search — it does NOT apply now. Do not repeat that disclaimer here; you were just given real-time " +
      `results, so use them.\n\nWeb search results for the user's message:\n\n${body}\n\n` +
      "Answer the user's question using these results, citing the source (by name or URL) when you use one. If " +
      "none of the results actually answer the question, say so plainly instead of guessing.",
  };
}

// Every send refetches and resends the ENTIRE conversation history with no cap — fine for short
// chats, but a long-running one eventually exceeds a provider's context window outright (a hard
// 400 from the API, with no partial reply) and gets slower/costlier every single turn regardless.
// Team Up in particular fans the same history out to whichever smaller-context models happen to
// be enabled, so the budget has to hold for the smallest realistic context window, not just
// Claude/Gemini's much larger ones. ~90k chars (~22k tokens at a rough 4 chars/token) comfortably
// fits everything actually enabled today while still covering a genuinely long conversation.
const MAX_HISTORY_CHARS = 90_000;

/**
 * Keeps the most recent messages that fit within MAX_HISTORY_CHARS, always keeping at least the
 * latest message (a single very long paste can still exceed the budget on its own) and dropping
 * from the oldest end first — a simple, provider-agnostic stand-in for real summarization.
 */
export function trimHistoryToBudget(history: ChatMessage[]): ChatMessage[] {
  let total = 0;
  // Default to keeping EVERYTHING — cutoff only moves forward if the loop below actually finds
  // a point where the budget is exceeded. This was wrongly initialized to `history.length`
  // (the "trim everything" value), so any conversation under the budget — i.e. nearly every
  // real conversation — silently sent an EMPTY messages array to every provider. That's not a
  // subtle context bug: it's the actual root cause of the "model answers something totally
  // unrelated" reports (Sarvam quoting its own system prompt back, ScaleMax hard-rejecting with
  // "'messages' must be a non-empty array") — the model was never shown the user's message at
  // all, current turn included, so of course it had nothing real to respond to.
  let cutoff = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    total += history[i]!.content.length;
    if (total > MAX_HISTORY_CHARS && i < history.length - 1) {
      cutoff = i + 1;
      break;
    }
  }
  return history.slice(cutoff);
}

/** Prepends web search results, a persona/behavior instruction, and/or the Think/Canvas/attachment nudges, in that order. */
export function withSystemPreamble(
  history: ChatMessage[],
  think: boolean,
  behavior: string,
  webSearch: boolean,
  searchResults: WebSearchResult[],
  canvas: boolean = false,
  hasAttachments: boolean = false,
): ChatMessage[] {
  const preamble: ChatMessage[] = [
    { role: "system", content: FOCUS_SYSTEM_PROMPT },
    { role: "system", content: HONESTY_SYSTEM_PROMPT },
    { role: "system", content: EXECUTION_HONESTY_SYSTEM_PROMPT },
    { role: "system", content: FORMAT_SYSTEM_PROMPT },
  ];
  if (webSearch) preamble.push(searchResultsToSystemMessage(searchResults));
  if (behavior.trim()) preamble.push({ role: "system", content: behavior.trim() });
  if (think) preamble.push({ role: "system", content: THINK_SYSTEM_PROMPT });
  // Canvas, then attachment-focus last of all — each overrides what came before it for the same
  // reason: the most recent instruction is the most salient one. A fresh attachment with a short
  // caption needs to win over everything else (an old topic, irrelevant search results), which is
  // exactly the case that failed in production — see ATTACHMENT_FOCUS_SYSTEM_PROMPT's comment.
  if (canvas) preamble.push({ role: "system", content: CANVAS_SYSTEM_PROMPT });
  if (hasAttachments) preamble.push({ role: "system", content: ATTACHMENT_FOCUS_SYSTEM_PROMPT });
  return preamble.length ? [...preamble, ...history] : history;
}

// Images ride along as base64 data URLs in the request body (no upload endpoint/storage yet), so
// this bounds the request size and the number of images a single vision call has to process.
const MAX_ATTACHMENTS = 4;

/**
 * Attaches the CURRENT turn's image data to the most recent message in `history` (always the
 * user's just-sent message — see sendMessage/streamMessage). Previously the "Canvas" bug's
 * sibling: the composer already let a user attach an image and showed a thumbnail for it, but the
 * attachment was never sent to the backend at all, so the model silently answered with no image
 * and no error.
 *
 * Earlier turns' images are re-hydrated separately, upstream in index.ts's history query (joins
 * message_attachments, which insertUserMessage/storeAttachments already persists) — so "that
 * image I sent earlier" does now work on a later turn, not just the turn it was attached to.
 */
export function attachImages(history: ChatMessage[], images: ChatImage[]): ChatMessage[] {
  if (images.length === 0 || history.length === 0) return history;
  const last = history[history.length - 1]!;
  const withImages: ChatMessage = { ...last, images: images.slice(0, MAX_ATTACHMENTS) };
  return [...history.slice(0, -1), withImages];
}

// Anthropic's real API understands a PDF as a "document" content block. ScaleMax, despite
// proxying an Anthropic-compatible /messages API, does NOT forward it — confirmed directly
// against their API (2026-09-16): a document block sent with or without the anthropic-beta PDF
// header comes back with input_tokens matching the text prompt alone (the model explicitly says
// no PDF was attached). Their proxy silently strips content types it doesn't recognize, so a
// ScaleMax-routed Claude model reads a PDF-carrying request as if the PDF were never there. Only
// the real Anthropic API and Gemini (native, not via any proxy) actually receive the file.
//
// This is now a secondary/bonus path, not the primary one — Sarvam's Doc AI digitise pipeline
// (sarvamDocAI.ts, verified live against the real API) extracts a PDF's text server-side, which
// works with ANY provider since it becomes ordinary message text rather than a file the model
// has to natively understand. unsupportedAttachmentReason() only fires when that extraction
// wasn't available/succeeded (no working Sarvam key, or the document itself failed digitising)
// AND the chosen model has no native fallback either — see streamMessage() in index.ts.
const PDF_CAPABLE_SLUGS = new Set(["anthropic", "gemini"]);

/**
 * Returns a human-readable reason the given provider can't see one of these attachments, or null
 * if every attachment is something that provider's adapter actually forwards. Vision-gate the
 * image case separately (via getModelVisionSupport) before calling this — this only covers the
 * "attached a file type this specific provider doesn't support" case (currently: PDF), and only
 * matters once Sarvam extraction has already been tried and failed/was unavailable.
 */
export function unsupportedAttachmentReason(providerSlug: string, images: ChatImage[]): string | null {
  const unsupportedPdf = images.some((img) => img.mime === "application/pdf") && !PDF_CAPABLE_SLUGS.has(providerSlug);
  if (unsupportedPdf) return "can't read PDFs — pick a Claude (direct Anthropic, not ScaleMax) or Gemini model, or remove the attachment.";
  return null;
}

/**
 * Folds Sarvam-extracted PDF text into the most recent message's content, in-memory only (same
 * "current turn only" limitation as attachImages — not persisted to the messages table). Applied
 * after attachImages() so the last message can carry both the raw file (for a PDF-native
 * provider) and its extracted text (for everyone else) at once.
 */
export function appendExtractedText(history: ChatMessage[], extractedText: string | null): ChatMessage[] {
  if (!extractedText || history.length === 0) return history;
  const last = history[history.length - 1]!;
  const withText: ChatMessage = {
    ...last,
    content: `${last.content}\n\n--- Extracted text from an attached PDF ---\n${extractedText}`,
  };
  return [...history.slice(0, -1), withText];
}
