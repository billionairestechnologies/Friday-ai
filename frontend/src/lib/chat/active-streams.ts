/**
 * Per-chat in-flight request tracking. Previously a single `AbortController` ref (and a single
 * "busy" boolean) covered the whole app, so sending in a second chat aborted whatever the first
 * chat was still streaming, and the composer refused to send into a new chat at all while any
 * other chat was generating — reported live as chats "getting stuck" when switching screens or
 * opening a new chat. Keying by chatId lets any number of chats stream concurrently; each only
 * ever aborts its own previous request, never anyone else's.
 */
const controllers = new Map<string, AbortController>();

/** Starts tracking a new request for this chat, aborting a stale one for the SAME chat if one
 *  was somehow still marked active (there shouldn't be, since sending is blocked while a chat's
 *  own turn is in flight — this is just a safety net, not the normal path). */
export function beginStream(chatId: string): AbortController {
  controllers.get(chatId)?.abort();
  const ac = new AbortController();
  controllers.set(chatId, ac);
  return ac;
}

/** Call in the request's `finally` — only clears the slot if it's still this exact controller,
 *  so a stale finally from an already-superseded request can't clobber a newer one. */
export function endStream(chatId: string, ac: AbortController) {
  if (controllers.get(chatId) === ac) controllers.delete(chatId);
}

export function stopStream(chatId: string) {
  controllers.get(chatId)?.abort();
}

export function isStreamActive(chatId: string | null | undefined): boolean {
  return chatId ? controllers.has(chatId) : false;
}
