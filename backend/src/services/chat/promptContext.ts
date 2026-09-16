import type { ChatImage, ChatMessage } from "../providers/types.js";
import type { WebSearchResult } from "../webSearch.js";

// Smaller/weaker chat models (e.g. Sarvam) can get anchored on the previous topic in a long
// history and answer a short new message — "hii", "thanks", "ok" — as if it were a continuation
// of the last question instead of what it actually is. This keeps every provider focused on the
// message that was actually just sent.
const FOCUS_SYSTEM_PROMPT =
  "Always respond to the user's latest message specifically. Earlier messages in this conversation are context, not the question — if the latest message is a greeting, a short reaction, or changes topic, respond to that directly instead of continuing to elaborate on an earlier topic.";

// Keeps replies grounded instead of reflexively agreeable — a request that's factually wrong,
// physically impossible, or a bad idea should be told so plainly, not validated.
const HONESTY_SYSTEM_PROMPT =
  "Don't just agree with or validate whatever the user proposes. If a request or claim is factually " +
  "wrong, physically impossible, unsafe, or a bad idea, say so plainly and explain why instead of being " +
  "agreeable. When something is genuinely reasonable or achievable, be encouraging and helpful about it — " +
  "but stay honest and grounded rather than telling the user what they want to hear.";

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
  "Canvas mode is ON: the user is looking at a live preview panel that renders your reply, not just this chat, so a conversational answer is not useful right now — they want a working result. Respond with ONE fenced code block containing complete, self-contained, runnable code: use ```html for a full standalone HTML page (inline <style>/<script>, no external files) for UI/visual/design requests, ```jsx for a single React component (a default-exported function component using only React and its own hooks — no imports beyond react), or ```python for a script that actually gets executed in a real Python sandbox and shows its printed output — use that for anything computational (data processing, algorithms, math) rather than a UI. A single short sentence before the code fence is fine, but do not explain what you would build instead of building it, and do not split the result across multiple code blocks.";

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

/** Prepends web search results, a persona/behavior instruction, and/or the Think/Canvas nudges, in that order. */
export function withSystemPreamble(
  history: ChatMessage[],
  think: boolean,
  behavior: string,
  webSearch: boolean,
  searchResults: WebSearchResult[],
  canvas: boolean = false,
): ChatMessage[] {
  const preamble: ChatMessage[] = [
    { role: "system", content: FOCUS_SYSTEM_PROMPT },
    { role: "system", content: HONESTY_SYSTEM_PROMPT },
  ];
  if (webSearch) preamble.push(searchResultsToSystemMessage(searchResults));
  if (behavior.trim()) preamble.push({ role: "system", content: behavior.trim() });
  if (think) preamble.push({ role: "system", content: THINK_SYSTEM_PROMPT });
  // Canvas last so it's the most recent/salient instruction — it overrides Think's "give a clear
  // direct final answer" framing with "that final answer IS the code fence," not prose about it.
  if (canvas) preamble.push({ role: "system", content: CANVAS_SYSTEM_PROMPT });
  return preamble.length ? [...preamble, ...history] : history;
}

// Images ride along as base64 data URLs in the request body (no upload endpoint/storage yet), so
// this bounds the request size and the number of images a single vision call has to process.
const MAX_ATTACHMENTS = 4;

/**
 * Attaches image data to the most recent message in `history` (always the user's just-sent
 * message — see sendMessage/streamMessage). Previously the "Canvas" bug's sibling: the composer
 * already let a user attach an image and showed a thumbnail for it, but the attachment was never
 * sent to the backend at all, so the model silently answered with no image and no error. Images
 * aren't persisted to the messages table (no column for them yet), so they're only usable for the
 * turn they were attached to, not for later turns referencing "that image" — a real limitation,
 * not the bug being fixed here.
 */
export function attachImages(history: ChatMessage[], images: ChatImage[]): ChatMessage[] {
  if (images.length === 0 || history.length === 0) return history;
  const last = history[history.length - 1]!;
  const withImages: ChatMessage = { ...last, images: images.slice(0, MAX_ATTACHMENTS) };
  return [...history.slice(0, -1), withImages];
}
