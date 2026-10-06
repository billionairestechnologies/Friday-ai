import { approvalOpen, consumeApproval, isLeaving, openApproval, recordAction, recentActions, type GateKind } from "../air/gate.js";

/**
 * Build Mode's side of the Air Dots gate (air/gate.ts): one recorded row for every shell, browser and
 * file action, and anything that leaves the account waits for a yes. This used to be an in-memory
 * array and map per server — the record vanished on restart and a phone "yes" taken on one instance
 * didn't open the gate on another.
 */

export type { GateKind };

export function noteGate(userId: string, conversationId: string, kind: GateKind, detail: string, decision: "allowed" | "approved" = "allowed") {
  void recordAction({ userId, conversationId, kind, name: kind, detail, decision });
}

export async function recentGate(userId: string, conversationId: string) {
  return recentActions(userId, conversationId, 30);
}

/** A spoken yes plus the passphrase (or the web button) opens the next leaving action for two minutes. */
export async function allowSensitive(userId: string, conversationId: string, via: "web" | "phone" = "phone") {
  await openApproval(userId, conversationId, via);
}

/** null = go ahead. A message = refused (and recorded). An open approval is used up by this action. */
export async function gateRefusal(userId: string, conversationId: string, kind: GateKind, detail: string): Promise<string | null> {
  if (!isLeaving(kind, kind, detail)) return null;
  if (await approvalOpen(conversationId)) {
    await consumeApproval(conversationId);
    noteGate(userId, conversationId, kind, detail, "approved");
    return null;
  }
  void recordAction({ userId, conversationId, kind, name: kind, detail, decision: "refused" });
  return "This leaves the account. It needs a yes and the passphrase before it runs.";
}
