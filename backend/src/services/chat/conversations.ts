import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import type { ConversationMode } from "./types.js";
import type { ChatImage } from "../providers/types.js";

export type MessageMetadata = {
  thinking?: string;
  citations?: { url: string; title?: string }[];
  agents?: { slug: string; model: string; state: "start" | "done" | "error"; error?: string }[];
  usedThink?: boolean;
  usedSearch?: boolean;
  usedCanvas?: boolean;
  error?: string;
};

export type PageOptions = {
  limit?: number;
  before?: string;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function pageSize(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

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

export async function listConversations(userId: string, page: PageOptions = {}) {
  let query = supabaseAdmin
    .from("conversations")
    .select("*, providers(slug, display_name)")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(pageSize(page.limit));
  if (page.before) query = query.lt("updated_at", page.before);
  const { data, error } = await query;
  if (error) throw new HttpError(500, error.message);
  return data;
}

export async function deleteAllConversations(userId: string) {
  const { error } = await supabaseAdmin.from("conversations").delete().eq("user_id", userId);
  if (error) throw new HttpError(500, error.message);
}

export async function deleteConversation(userId: string, conversationId: string) {
  await getOwnedConversation(userId, conversationId);
  const { error } = await supabaseAdmin.from("conversations").delete().eq("id", conversationId);
  if (error) throw new HttpError(500, error.message);
}

export async function listMessages(userId: string, conversationId: string, page: PageOptions = {}) {
  await getOwnedConversation(userId, conversationId);
  let query = supabaseAdmin
    .from("messages")
    .select("*, message_attachments(*)")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(pageSize(page.limit));
  if (page.before) query = query.lt("created_at", page.before);
  const { data, error } = await query;
  if (error) throw new HttpError(500, error.message);
  return [...(data ?? [])].reverse();
}

export async function insertUserMessage(
  conversationId: string,
  content: string,
  inputMode: "text" | "voice",
  attachments: ChatImage[],
) {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .insert({ conversation_id: conversationId, role: "user", content, input_mode: inputMode })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to save message");

  if (attachments.length > 0) {
    const { error: attachmentError } = await supabaseAdmin.from("message_attachments").insert(
      attachments.map((attachment, index) => ({
        message_id: data.id,
        name: attachment.name || `attachment-${index + 1}`,
        mime: attachment.mime,
        size_bytes: attachment.size ?? 0,
        kind: attachment.kind ?? (attachment.mime.startsWith("image/") ? "image" : "file"),
        data_url: attachment.dataUrl,
      })),
    );
    if (attachmentError) throw new HttpError(500, attachmentError.message);
  }

  return data;
}

export async function insertAssistantMessage(
  conversationId: string,
  content: string,
  modelLabel: string,
  metadata: MessageMetadata = {},
) {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .insert({
      conversation_id: conversationId,
      role: "assistant",
      content,
      model_label: modelLabel,
      thinking: metadata.thinking || null,
      citations: metadata.citations ?? [],
      agents: metadata.agents ?? [],
      used_think: metadata.usedThink ?? Boolean(metadata.thinking),
      used_search: metadata.usedSearch ?? Boolean(metadata.citations?.length),
      used_canvas: metadata.usedCanvas ?? false,
      error: metadata.error ?? null,
    })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to save reply");
  return data;
}
