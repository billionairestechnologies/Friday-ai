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

/** One short, friendly line for any provider error ("<slug>: <Provider> chat failed: <status> <body>"). */
export function friendlyProviderError(raw: string): string {
  const text = raw.trim();
  const status = /chat failed:\s*(\d{3})\b/i.exec(text)?.[1] ?? /\b([45]\d{2})\b/.exec(text)?.[1];
  const looksHtml = /<!doctype html|<html[\s>]/i.test(text);

  if (looksHtml || (status && /^(408|429|500|502|503|504|520|521|522|523|524|529)$/.test(status))) return BUSY;
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|overloaded/i.test(text)) return BUSY;
  // 402 = the provider account is out of credit: ours to fix, never the user's, and never worth quoting.
  if (status === "401" || status === "402" || status === "403") return UNAVAILABLE;
  if (status === "400" && /payload size|too (long|large)|context|token/i.test(text)) return TOO_LARGE;

  // Anything else: first line only, vendor prefix and markup stripped, length capped. Callers still
  // match on short wording here (e.g. "tools not supported" -> plain streaming).
  const oneLine = (text.split("\n")[0] ?? text)
    .replace(/^[a-z0-9_-]{2,24}:\s+/i, "")
    .replace(/^\w[\w .-]{0,30} chat failed:\s*(\d{3}\s*)?/i, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine) return UNAVAILABLE;
  return oneLine.length > 220 ? `${oneLine.slice(0, 220)}…` : oneLine;
}
