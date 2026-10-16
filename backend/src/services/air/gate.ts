import { supabaseAdmin } from "../../config/supabase.js";

/**
 * The gate: every shell, browser, file, connector and tool action an Air Dot takes is recorded
 * (air_actions), and anything that leaves the account — pay, buy, book, send, post, delete — waits for
 * a yes (air_approvals, opened by the web button or a spoken yes + passphrase). Shared by the Air Dots
 * tool wrapper (air/tools.ts) and Build Mode's sandbox (projectBuild/actionGate.ts), so the rule is
 * the same everywhere and holds across instances (it used to be an in-memory array per server).
 */

export type GateKind = "file" | "shell" | "browser" | "tool" | "connector";
export type GateDecision = "allowed" | "refused" | "approved";

export const APPROVAL_WINDOW_MS = 2 * 60_000;

const LEAVING_WORDS = /\b(pay|payment|checkout|check out|purchase|buy( now)?|place (the )?order|book( now)?|confirm (order|booking|payment)|send|post|publish|tweet|delete|unsubscribe|transfer|withdraw|submit order)\b/i;
const LEAVING_SHELL = /\b(rm\s+-rf\s+[~/]|curl\b[^|]*-X\s*(POST|PUT|DELETE)|git\s+push\b.*--force)/i;
const LEAVING_TOOL_NAME = /(^|_)(send|delete|remove|pay|purchase|transfer|post|publish|create_issue|merge|reply|forward|trash)(_|$)/i;

/**
 * Whether an action leaves the account. Pure; tested. `label` is what the person would see (a button
 * text from the browser snapshot, a connector tool name, a shell command).
 */
export function isLeaving(kind: GateKind, name: string, label: string): boolean {
  if (kind === "file") return false;
  if (kind === "shell") return LEAVING_SHELL.test(label);
  if (kind === "browser") return LEAVING_WORDS.test(label);
  // Connector / MCP tools: the tool's own name says what it does (gmail_send, github_create_issue…).
  return LEAVING_TOOL_NAME.test(name) || (kind === "connector" && LEAVING_WORDS.test(name));
}

export async function recordAction(row: {
  userId: string;
  conversationId: string;
  jobId?: string | null;
  kind: GateKind;
  name: string;
  detail: string;
  decision: GateDecision;
}): Promise<void> {
  await supabaseAdmin
    .from("air_actions")
    .insert({
      user_id: row.userId,
      conversation_id: row.conversationId,
      job_id: row.jobId ?? null,
      kind: row.kind,
      name: row.name.slice(0, 120),
      detail: row.detail.slice(0, 1000),
      decision: row.decision,
    })
    .then(() => undefined, () => undefined);
}

export async function approvalOpen(conversationId: string, now = Date.now()): Promise<boolean> {
  const { data } = await supabaseAdmin.from("air_approvals").select("until").eq("conversation_id", conversationId).maybeSingle();
  const until = (data as { until?: string } | null)?.until;
  return Boolean(until && new Date(until).getTime() > now);
}

/** A yes opens leaving actions on this conversation for two minutes. */
export async function openApproval(userId: string, conversationId: string, via: "web" | "phone" | "whatsapp" | "telegram") {
  const until = new Date(Date.now() + APPROVAL_WINDOW_MS).toISOString();
  await supabaseAdmin.from("air_approvals").upsert({ conversation_id: conversationId, user_id: userId, until, via });
  return { until };
}

/** One leaving action per yes: the window closes after it runs. */
export async function consumeApproval(conversationId: string) {
  await supabaseAdmin.from("air_approvals").delete().eq("conversation_id", conversationId).then(() => undefined, () => undefined);
}

export async function recentActions(userId: string, conversationId: string, limit = 50) {
  const { data } = await supabaseAdmin
    .from("air_actions")
    .select("id, kind, name, detail, decision, created_at")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}
