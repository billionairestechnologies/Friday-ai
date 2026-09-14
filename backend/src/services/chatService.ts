import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { getProviderAdapter } from "./providers/registry.js";
import type { ChatMessage } from "./providers/types.js";
import { getWorkingKeyForProvider, listChatCandidates, type ChatCandidate } from "./providerService.js";

export type ConversationMode = "single" | "auto" | "teamup";

// Team Up fans a message out to at most this many distinct providers, one model each,
// so a single send doesn't burn through every configured key at once.
const TEAMUP_MAX_MODELS = 3;

async function getOwnedConversation(userId: string, conversationId: string) {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("*, providers(slug, display_name)")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new HttpError(404, "Conversation not found");
  return data as typeof data & { providers: { slug: string; display_name: string } | null };
}

export async function createConversation(
  userId: string,
  mode: ConversationMode,
  providerSlug?: string,
  modelId?: string,
  title?: string,
) {
  let providerRowId: string | null = null;

  if (mode === "single") {
    if (!providerSlug || !modelId) throw new HttpError(400, "providerSlug and modelId are required for single mode");
    const { data: provider, error: providerError } = await supabaseAdmin
      .from("providers")
      .select("id")
      .eq("slug", providerSlug)
      .single();
    if (providerError || !provider) throw new HttpError(400, `Unknown provider: ${providerSlug}`);
    providerRowId = provider.id;
  }

  const defaultTitle = mode === "auto" ? "Auto chat" : mode === "teamup" ? "Team Up chat" : "New chat";

  const { data, error } = await supabaseAdmin
    .from("conversations")
    .insert({
      user_id: userId,
      provider_id: providerRowId,
      model_id: mode === "single" ? modelId : null,
      mode,
      title: title || defaultTitle,
    })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to create conversation");
  return data;
}

export async function listConversations(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("*, providers(slug, display_name)")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw new HttpError(500, error.message);
  return data;
}

export async function deleteConversation(userId: string, conversationId: string) {
  await getOwnedConversation(userId, conversationId);
  const { error } = await supabaseAdmin.from("conversations").delete().eq("id", conversationId);
  if (error) throw new HttpError(500, error.message);
}

export async function listMessages(userId: string, conversationId: string) {
  await getOwnedConversation(userId, conversationId);
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at");
  if (error) throw new HttpError(500, error.message);
  return data;
}

async function insertAssistantMessage(conversationId: string, content: string, modelLabel: string) {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .insert({ conversation_id: conversationId, role: "assistant", content, model_label: modelLabel })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to save reply");
  return data;
}

async function callCandidate(candidate: ChatCandidate, history: ChatMessage[]): Promise<string> {
  const adapter = getProviderAdapter(candidate.slug);
  const apiKey = await getWorkingKeyForProvider(candidate.slug);
  return adapter.chat(apiKey, candidate.modelId, history);
}

/** Picks distinct providers so Team Up compares different vendors rather than two models from one. */
function pickDistinctProviders(candidates: ChatCandidate[], limit: number): ChatCandidate[] {
  const seen = new Set<string>();
  const picked: ChatCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    picked.push(c);
    if (picked.length >= limit) break;
  }
  return picked;
}

export async function sendMessage(
  userId: string,
  conversationId: string,
  content: string,
  inputMode: "text" | "voice" = "text",
) {
  const conversation = await getOwnedConversation(userId, conversationId);

  const { error: insertError } = await supabaseAdmin
    .from("messages")
    .insert({ conversation_id: conversationId, role: "user", content, input_mode: inputMode });
  if (insertError) throw new HttpError(500, insertError.message);

  const { data: historyRows, error: historyError } = await supabaseAdmin
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at");
  if (historyError) throw new HttpError(500, historyError.message);
  const history = historyRows as ChatMessage[];

  const mode = conversation.mode as ConversationMode;
  let replies: Awaited<ReturnType<typeof insertAssistantMessage>>[];

  if (mode === "single") {
    if (!conversation.providers || !conversation.model_id) {
      throw new HttpError(500, "Conversation is missing its provider/model");
    }
    const text = await callCandidate(
      { slug: conversation.providers.slug, providerDisplayName: conversation.providers.display_name, modelId: conversation.model_id, displayName: conversation.model_id },
      history,
    );
    replies = [await insertAssistantMessage(conversationId, text, conversation.providers.display_name)];
  } else if (mode === "auto") {
    const candidates = await listChatCandidates();
    if (candidates.length === 0) throw new HttpError(503, "No chat models are enabled yet");

    const errors: string[] = [];
    let reply: Awaited<ReturnType<typeof insertAssistantMessage>> | null = null;
    for (const candidate of candidates) {
      try {
        const text = await callCandidate(candidate, history);
        reply = await insertAssistantMessage(conversationId, text, `Auto → ${candidate.providerDisplayName}`);
        break;
      } catch (err) {
        errors.push(`${candidate.slug}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    if (!reply) throw new HttpError(503, `Every model failed. ${errors.join("; ")}`);
    replies = [reply];
  } else {
    // teamup
    const candidates = pickDistinctProviders(await listChatCandidates(), TEAMUP_MAX_MODELS);
    if (candidates.length === 0) throw new HttpError(503, "No chat models are enabled yet");

    const results = await Promise.allSettled(
      candidates.map(async (candidate) => ({
        candidate,
        text: await callCandidate(candidate, history),
      })),
    );

    const inserted: Awaited<ReturnType<typeof insertAssistantMessage>>[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        inserted.push(
          await insertAssistantMessage(
            conversationId,
            result.value.text,
            `${result.value.candidate.providerDisplayName} — ${result.value.candidate.displayName}`,
          ),
        );
      }
    }
    if (inserted.length === 0) throw new HttpError(503, "Every model in the team failed to respond");
    replies = inserted;
  }

  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);

  return replies;
}
