import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { getOwnedConversation } from "./conversations.js";

export type SearchHit = { conversationId: string; title: string; messageId: string; role: string; snippet: string; createdAt: string };

/** A ~160-char window of `content` around the first query term, for the result list. */
export function snippetAround(content: string, query: string, width = 160): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const lower = flat.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** Full-text search over all of the user's messages (Postgres websearch syntax: "quoted phrase", -exclude, or). */
export async function searchMessages(userId: string, query: string, limit = 30): Promise<SearchHit[]> {
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return [];
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("id, conversation_id, role, content, created_at, conversations!inner(id, title, user_id)")
    .eq("conversations.user_id", userId)
    .textSearch("search_tsv", q, { type: "websearch", config: "simple" })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).map((row) => {
    const conv = (row as { conversations?: { title?: string } | { title?: string }[] }).conversations;
    const title = (Array.isArray(conv) ? conv[0]?.title : conv?.title) ?? "Chat";
    return {
      conversationId: row.conversation_id as string,
      title,
      messageId: row.id as string,
      role: row.role as string,
      snippet: snippetAround(row.content as string, q),
      createdAt: row.created_at as string,
    };
  });
}

export async function shareConversation(userId: string, conversationId: string): Promise<{ token: string }> {
  const conversation = (await getOwnedConversation(userId, conversationId)) as { share_token?: string | null };
  if (conversation.share_token) return { token: conversation.share_token };
  const token = randomBytes(18).toString("base64url");
  const { error } = await supabaseAdmin
    .from("conversations")
    .update({ share_token: token, shared_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("user_id", userId);
  if (error) throw new HttpError(500, error.message);
  return { token };
}

export async function unshareConversation(userId: string, conversationId: string): Promise<void> {
  await getOwnedConversation(userId, conversationId);
  const { error } = await supabaseAdmin
    .from("conversations")
    .update({ share_token: null, shared_at: null })
    .eq("id", conversationId)
    .eq("user_id", userId);
  if (error) throw new HttpError(500, error.message);
}

/** Public, read-only view of a shared chat: text only — no attachments, reasoning, or owner identity. */
export async function getSharedConversation(token: string) {
  if (!/^[\w-]{20,40}$/.test(token)) throw new HttpError(404, "This link doesn't exist or was turned off");
  const { data: conversation } = await supabaseAdmin
    .from("conversations")
    .select("id, title, shared_at")
    .eq("share_token", token)
    .maybeSingle();
  if (!conversation) throw new HttpError(404, "This link doesn't exist or was turned off");
  const { data: messages, error } = await supabaseAdmin
    .from("messages")
    .select("role, content, model_label, created_at")
    .eq("conversation_id", conversation.id)
    .in("role", ["user", "assistant"])
    .order("created_at")
    .limit(500);
  if (error) throw new HttpError(500, error.message);
  return {
    title: conversation.title as string,
    sharedAt: conversation.shared_at as string,
    messages: (messages ?? []).map((m) => ({
      role: m.role as string,
      content: m.content as string,
      model: (m.model_label as string | null) ?? null,
      createdAt: m.created_at as string,
    })),
  };
}
