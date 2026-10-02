// A provider failure reaches the user as chat text AND is stored with the conversation, so it must
// never be the raw upstream response. Production incident (2026-10-02): ScaleMax answered 502 with a
// whole Cloudflare HTML error page, which was shown (and saved) as the reply; the next turns then
// re-sent that page as history and the model rejected the oversized request (400).

const GATEWAY = /\b(502|503|504|520|521|522|523|524)\b/;

/** One short, readable line for any provider error message ("<slug>: <Provider> chat failed: <status> <body>"). */
export function friendlyProviderError(raw: string): string {
  const text = raw.trim();
  const slug = /^([a-z0-9_-]{2,24}):\s/i.exec(text)?.[1];
  const who = slug ? `${slug[0]!.toUpperCase()}${slug.slice(1)}` : "The model provider";
  const looksHtml = /<!doctype html|<html[\s>]/i.test(text);
  const status = /chat failed:\s*(\d{3})\b/i.exec(text)?.[1] ?? /\b([45]\d{2})\b/.exec(text)?.[1];

  if (looksHtml || (status && GATEWAY.test(status))) return `${who} is temporarily unavailable (gateway error ${status ?? ""}). Try again in a moment or pick another model.`.replace("( ", "(").replace(" )", ")");
  if (status === "429") return `${who} is rate-limiting requests right now. Try again in a moment or pick another model.`;
  if (status === "401" || status === "403") return `${who} rejected Friday's credentials. The team has been notified; try another model meanwhile.`;
  if (status === "400" && /payload size|too (long|large)|context|token/i.test(text)) return `${who} couldn't take this message — the chat or paste is too large for that model. Try a shorter message, a new chat, or another model.`;
  // Other 400s keep their own (short) wording: callers match on it, e.g. "tools not supported" -> plain streaming.

  // Anything else: keep the first line only, cap the length, never surface markup.
  const oneLine = (text.split("\n")[0] ?? text).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > 220 ? `${oneLine.slice(0, 220)}…` : oneLine || "The model failed to respond";
}
