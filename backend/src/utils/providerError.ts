// A provider failure reaches the user as chat text AND is stored with the conversation, so it must
// never be the raw upstream response, and it must not name the vendor or leak backend detail.
// Production incident (2026-10-02): ScaleMax answered 502 with a whole Cloudflare HTML error page, which
// was shown (and saved) as the reply; the next turns then re-sent that page as history and the model
// rejected the oversized request (400). The raw text goes to the server log only.

const BUSY =
  "We're facing high usage right now. Please wait a few minutes and try again, or switch to a different model. We'll be back to normal soon — if it keeps happening, contact support.";
const UNAVAILABLE =
  "This model isn't available right now. Please try a different model, or try again in a few minutes. If it keeps happening, contact support and we'll look into it.";
const TOO_LARGE = "That message is too large for this model. Try a shorter message, start a new chat, or pick another model.";

export type ProviderIssueKind = "quota" | "gateway" | "rate_limit" | "auth" | "too_large" | "other";

const VENDOR = /\b(scalemax|openai|anthropic|claude|gemini|google ai|openrouter|sarvam|ollama|elevenlabs|e2b|cloudflare|tavily|tinyfish|supabase|razorpay|resend)\b/i;
const QUOTA = /quota|insufficient[_ ]?(credit|funds|balance)|token pack|token allocation|credit|billing|payment required|exceeded your (current )?(quota|plan)|out of (credit|tokens)/i;

/** What went wrong, for the admin log (never shown to users). */
export function classifyProviderIssue(raw: string): ProviderIssueKind {
  const text = raw.trim();
  const status = /chat failed:\s*(\d{3})\b/i.exec(text)?.[1] ?? /\b([45]\d{2})\b/.exec(text)?.[1];
  if (status === "402" || QUOTA.test(text)) return "quota";
  if (status === "429") return "rate_limit";
  if (status === "401" || status === "403" || /invalid.{0,20}(api )?key|unauthori[sz]ed/i.test(text)) return "auth";
  if (status === "400" && /payload size|too (long|large)|context/i.test(text)) return "too_large";
  if (/<!doctype html|<html[\s>]/i.test(text) || (status && /^(408|500|502|503|504|520|521|522|523|524|529)$/.test(status)) || /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|overloaded/i.test(text)) return "gateway";
  return "other";
}

/** True when a message that is about to reach a user still looks like provider/backend output (JSON, HTML,
 *  request ids). Deliberately NOT keyed on vendor names or "quota": Friday's own plan-limit messages and
 *  model display names ("Claude …") are legitimate user-facing text. */
export function looksLikeProviderNoise(msg: string): boolean {
  return /^\s*[{\[]/.test(msg) || /"(type|error|request_id|message)"\s*:/.test(msg) || /<[a-z!][^>]*>/i.test(msg) || /chat failed|failed: \d{3}\b|request_id|request-id|status code \d{3}/i.test(msg);
}

/** Last line of defence for every error event: raw provider output never reaches a user, whichever code path produced it. */
export function sanitizeUserError(msg: string): string {
  return looksLikeProviderNoise(msg) ? friendlyProviderError(msg) : msg;
}

/** One short, friendly line for any provider error ("<slug>: <Provider> chat failed: <status> <body>"). */
export function friendlyProviderError(raw: string): string {
  const text = raw.trim();
  const status = /chat failed:\s*(\d{3})\b/i.exec(text)?.[1] ?? /\b([45]\d{2})\b/.exec(text)?.[1];
  const looksHtml = /<!doctype html|<html[\s>]/i.test(text);

  if (looksHtml || (status && /^(408|429|500|502|503|504|520|521|522|523|524|529)$/.test(status))) return BUSY;
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|overloaded/i.test(text)) return BUSY;
  // 402 = the provider account is out of credit: ours to fix, never the user's, and never worth quoting.
  if (status === "401" || status === "402" || status === "403" || QUOTA.test(text)) return UNAVAILABLE;
  if (status === "400" && /payload size|too (long|large)|context|token/i.test(text)) return TOO_LARGE;

  // Anything else: first line only, vendor prefix and markup stripped, length capped. Callers still
  // match on short wording here (e.g. "tools not supported" -> plain streaming).
  if (/^\s*[{\[]/.test(text) || /"(type|error|request_id)"\s*:/.test(text)) return UNAVAILABLE;
  const oneLine = (text.split("\n")[0] ?? text)
    .replace(/^[a-z0-9_-]{2,24}:\s+/i, "")
    .replace(/^\w[\w .-]{0,30} chat failed:\s*(\d{3}\s*)?/i, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine || VENDOR.test(oneLine)) return UNAVAILABLE;
  return oneLine.length > 220 ? `${oneLine.slice(0, 220)}…` : oneLine;
}
