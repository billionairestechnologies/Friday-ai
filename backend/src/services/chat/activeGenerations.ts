/**
 * In-flight generations, keyed by conversation. Generation is deliberately decoupled from the
 * HTTP connection: closing the tab / killing the app drops the SSE socket but the reply keeps
 * being produced and persisted. The only thing that cancels one is an explicit Stop
 * (POST /chat/conversations/:id/stop), which looks it up here.
 */
type Entry = { userId: string; controller: AbortController };

const active = new Map<string, Entry>();

export function registerGeneration(conversationId: string, userId: string): AbortController {
  active.get(conversationId)?.controller.abort();
  const controller = new AbortController();
  active.set(conversationId, { userId, controller });
  return controller;
}

export function finishGeneration(conversationId: string, controller: AbortController) {
  if (active.get(conversationId)?.controller === controller) active.delete(conversationId);
}

/** True while a reply/build for this conversation is still being generated (Build sessions list). */
export function isGenerating(conversationId: string): boolean {
  return active.has(conversationId);
}

export function stopGeneration(conversationId: string, userId: string): boolean {
  const entry = active.get(conversationId);
  if (!entry || entry.userId !== userId) return false;
  entry.controller.abort();
  return true;
}
