import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { getProviderAdapter } from "./providers/registry.js";
import type { ChatMessage } from "./providers/types.js";
import { getWorkingKeyForProvider } from "./providerService.js";

async function getOwnedConversation(userId: string, conversationId: string) {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("*, providers(slug, display_name)")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new HttpError(404, "Conversation not found");
  return data as typeof data & { providers: { slug: string; display_name: string } };
}

export async function createConversation(userId: string, providerSlug: string, modelId: string, title?: string) {
  const { data: provider, error: providerError } = await supabaseAdmin
    .from("providers")
    .select("id")
    .eq("slug", providerSlug)
    .single();
  if (providerError || !provider) throw new HttpError(400, `Unknown provider: ${providerSlug}`);

  const { data, error } = await supabaseAdmin
    .from("conversations")
    .insert({ user_id: userId, provider_id: provider.id, model_id: modelId, title: title || "New chat" })
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

export async function sendMessage(
  userId: string,
  conversationId: string,
  content: string,
  inputMode: "text" | "voice" = "text",
) {
  const conversation = await getOwnedConversation(userId, conversationId);
  const providerSlug = conversation.providers.slug;
  const modelId = conversation.model_id as string;

  const { error: insertError } = await supabaseAdmin
    .from("messages")
    .insert({ conversation_id: conversationId, role: "user", content, input_mode: inputMode });
  if (insertError) throw new HttpError(500, insertError.message);

  const { data: history, error: historyError } = await supabaseAdmin
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at");
  if (historyError) throw new HttpError(500, historyError.message);

  const adapter = getProviderAdapter(providerSlug);
  const apiKey = await getWorkingKeyForProvider(providerSlug);
  const replyText = await adapter.chat(apiKey, modelId, history as ChatMessage[]);

  const { data: assistantMessage, error: assistantError } = await supabaseAdmin
    .from("messages")
    .insert({ conversation_id: conversationId, role: "assistant", content: replyText })
    .select()
    .single();
  if (assistantError || !assistantMessage) throw new HttpError(500, assistantError?.message ?? "Failed to save reply");

  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);

  return assistantMessage;
}
