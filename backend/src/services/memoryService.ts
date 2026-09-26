import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";

/**
 * Long-term user memory (table user_memories): short facts carried into every chat. Written by the
 * model through the `remember` / `forget` tools and managed by the user from Settings.
 */

export const MAX_MEMORIES = 200;
export const MAX_MEMORY_CHARS = 500;
/** Prompt budget for memories — the newest ones win when a user has more than fits. */
const PROMPT_BUDGET_CHARS = 6000;

export type UserMemory = { id: string; content: string; createdAt: string };

export function normalizeMemory(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_CHARS);
}

export async function listMemories(userId: string): Promise<UserMemory[]> {
  const { data, error } = await supabaseAdmin
    .from("user_memories")
    .select("id, content, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(MAX_MEMORIES);
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).map((row) => ({ id: row.id as string, content: row.content as string, createdAt: row.created_at as string }));
}

export async function addMemory(userId: string, raw: string, conversationId?: string | null): Promise<UserMemory> {
  const content = normalizeMemory(raw);
  if (!content) throw new HttpError(400, "Memory is empty");
  const existing = await listMemories(userId);
  const duplicate = existing.find((m) => m.content.toLowerCase() === content.toLowerCase());
  if (duplicate) return duplicate;
  if (existing.length >= MAX_MEMORIES) {
    // Oldest memory makes room — a full memory should never block saving what the user just said.
    await supabaseAdmin.from("user_memories").delete().eq("id", existing[0]!.id).eq("user_id", userId);
  }
  const { data, error } = await supabaseAdmin
    .from("user_memories")
    .insert({ user_id: userId, content, source_conversation_id: conversationId ?? null })
    .select("id, content, created_at")
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to save memory");
  return { id: data.id as string, content: data.content as string, createdAt: data.created_at as string };
}

export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("user_memories").delete().eq("user_id", userId).eq("id", id).select("id");
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).length > 0;
}

export async function clearMemories(userId: string): Promise<void> {
  const { error } = await supabaseAdmin.from("user_memories").delete().eq("user_id", userId);
  if (error) throw new HttpError(500, error.message);
}

/** The system-prompt block listing what Friday remembers, or null when there is nothing. Ids are
 *  included so the model can `forget` a specific one when the user asks. */
export function memoriesToSystemPrompt(memories: UserMemory[]): string | null {
  if (memories.length === 0) return null;
  const lines: string[] = [];
  let used = 0;
  for (const m of [...memories].reverse()) {
    const line = `- [${m.id}] ${m.content}`;
    if (used + line.length > PROMPT_BUDGET_CHARS) break;
    used += line.length;
    lines.unshift(line);
  }
  return (
    "What you remember about this user from earlier conversations (their saved memories — use them " +
    "naturally when relevant, don't recite them unprompted):\n" +
    lines.join("\n")
  );
}

/** Best-effort memory prompt for a chat turn — a memory lookup failure must never break chat. */
export async function loadMemoryPrompt(userId: string): Promise<string | null> {
  try {
    return memoriesToSystemPrompt(await listMemories(userId));
  } catch (err) {
    console.error("[memory] load failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
