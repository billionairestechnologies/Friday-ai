/** One record for shell, browser, and files. Pay, send, and delete wait for a yes. */

export type GateKind = "file" | "shell" | "browser";

export type GateRecord = {
  at: number;
  userId: string;
  conversationId: string;
  kind: GateKind;
  detail: string;
};

const LEAVES = /\b(pay|checkout|purchase|delete account|rm\s+-rf)\b/i;
const records: GateRecord[] = [];
const allowed = new Map<string, number>();

export function noteGate(userId: string, conversationId: string, kind: GateKind, detail: string) {
  records.push({ at: Date.now(), userId, conversationId, kind, detail: detail.slice(0, 500) });
  if (records.length > 500) records.shift();
}

export function recentGate(conversationId: string) {
  return records.filter((row) => row.conversationId === conversationId).slice(-30);
}

/** A spoken yes plus the passphrase opens the next leaving action for two minutes. */
export function allowSensitive(conversationId: string) {
  allowed.set(conversationId, Date.now() + 120_000);
}

export function gateRefusal(conversationId: string, kind: GateKind, detail: string): string | null {
  if (kind === "file" || !LEAVES.test(detail)) return null;
  const until = allowed.get(conversationId) ?? 0;
  if (until > Date.now()) return null;
  return "This leaves the account. It needs a yes and the passphrase before it runs.";
}

export function resetActionGate() {
  records.length = 0;
  allowed.clear();
}
