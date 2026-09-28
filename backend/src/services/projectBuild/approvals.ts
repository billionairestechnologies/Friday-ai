/**
 * In-memory approval handshake between a running build turn (agent.ts, blocked awaiting the user's
 * decision) and the approve/reject HTTP endpoints (buildController.ts). One build turn runs per
 * conversation at a time in a single Node process, so a plain Map keyed by conversationId is enough
 * — no queue/pubsub needed. Entries are ephemeral: a server restart mid-approval just leaves the
 * build turn to time out on its own next save, same as any other interrupted request.
 */
const pending = new Map<string, (approved: boolean) => void>();

export function waitForApproval(conversationId: string): Promise<boolean> {
  return new Promise((resolve) => {
    pending.set(conversationId, resolve);
  });
}

/** Returns false if nothing was waiting (e.g. the approval already timed out or was already resolved). */
export function resolveApproval(conversationId: string, approved: boolean): boolean {
  const resolve = pending.get(conversationId);
  if (!resolve) return false;
  pending.delete(conversationId);
  resolve(approved);
  return true;
}

export function hasPendingApproval(conversationId: string): boolean {
  return pending.has(conversationId);
}
