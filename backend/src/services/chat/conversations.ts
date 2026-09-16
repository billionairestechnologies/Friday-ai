import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import type { ConversationMode } from "./types.js";

export async function getOwnedConversation(userId: string, conversationId: string) {
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

/**
 * Switches which model/mode an existing conversation answers with, effective from the next
 * message onward — used when the user picks a different model mid-conversation instead of only
 * at creation time.
 */
export async function updateConversationModel(
  userId: string,
  conversationId: string,
  mode: ConversationMode,
  providerSlug?: string,
  modelId?: string,
) {
  await getOwnedConversation(userId, conversationId);

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

  const { data, error } = await supabaseAdmin
    .from("conversations")
    .update({
      provider_id: providerRowId,
      model_id: mode === "single" ? (modelId ?? null) : null,
      mode,
    })
    .eq("id", conversationId)
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to switch model");
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

export async function insertAssistantMessage(conversationId: string, content: string, modelLabel: string) {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .insert({ conversation_id: conversationId, role: "assistant", content, model_label: modelLabel })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to save reply");
  return data;
}
