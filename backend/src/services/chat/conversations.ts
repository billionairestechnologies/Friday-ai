import { saveFromMessage } from "../libraryService.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import type { ConversationMode } from "./types.js";
import type { ChatImage } from "../providers/types.js";
import { getOwnedProject } from "../projectService.js";
import { resolveAttachmentDataUrl, storeAttachments } from "../attachmentStorage.js";

export type MessageMetadata = {
  thinking?: string;
  citations?: { url: string; title?: string }[];
  agents?: { slug: string; model: string; state: "start" | "done" | "error"; error?: string }[];
  usedThink?: boolean;
  usedSearch?: boolean;
  usedCanvas?: boolean;
  error?: string;
  build?: import("./types.js").BuildMeta;
  files?: import("../documents/documentService.js").GeneratedFile[];
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
    .select(
      "*, providers(slug, display_name), assistant_projects(name, mode, description, instructions, repository_url)",
    )
    .eq("id", conversationId)
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new HttpError(404, "Conversation not found");
  return data as typeof data & {
    providers: { slug: string; display_name: string } | null;
    assistant_projects: {
      name: string;
      mode: "personal" | "work" | "developer";
      description: string;
      instructions: string;
      repository_url: string | null;
    } | null;
  };
}

export async function createConversation(
  userId: string,
  mode: ConversationMode,
  providerSlug?: string,
  modelId?: string,
  title?: string,
  projectId?: string,
  workspace: "chat" | "build" = "chat",
  origin: "web" | "air" = "web",
) {
  let providerRowId: string | null = null;
  if (projectId) await getOwnedProject(userId, projectId);

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

  const defaultTitle = workspace === "build" ? "New build" : mode === "auto" ? "Auto chat" : mode === "teamup" ? "Team Up chat" : "New chat";

  const { data, error } = await supabaseAdmin
    .from("conversations")
    .insert({
      user_id: userId,
      provider_id: providerRowId,
      model_id: mode === "single" ? modelId : null,
      mode,
      title: title || defaultTitle,
      project_id: projectId ?? null,
      // Only written for build sessions, so ordinary chat creation keeps working on a database
      // where migration 0030 (conversations.workspace) hasn't been applied yet.
      ...(workspace === "build" ? { workspace } : {}),
      ...(origin === "air" ? { origin } : {}),
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

/**
 * Projects are project-scoped only: a conversation created inside a project is left out of the
 * general chat list and only shows up when browsing that project (projectId passed). With no
 * projectId, this returns just the unscoped chats — the ones that belong to no project.
 */
export async function listConversations(userId: string, page: PageOptions = {}, projectId?: string) {
  let query = supabaseAdmin
    .from("conversations")
    .select("*, providers(slug, display_name), build_projects(conversation_id)")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(pageSize(page.limit));
  query = projectId ? query.eq("project_id", projectId) : query.is("project_id", null);
  if (page.before) query = query.lt("updated_at", page.before);
  const { data, error } = await query;
  if (error) throw new HttpError(500, error.message);
  // has_build: a project exists for this chat (Build Mode ran in it, from any workspace) — the web
  // app's Build workspace lists these alongside dedicated build sessions.
  return (data ?? []).map(({ build_projects, ...row }) => ({
    ...row,
    has_build: Array.isArray(build_projects) ? build_projects.length > 0 : Boolean(build_projects),
  }));
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

async function withResolvedAttachments<T extends { message_attachments?: Array<Record<string, unknown>> | null }>(
  rows: T[],
): Promise<T[]> {
  return Promise.all(
    rows.map(async (row) => {
      const attachments = row.message_attachments;
      if (!attachments?.length) return row;
      const resolved = await Promise.all(
        attachments.map(async (attachment) => ({
          ...attachment,
          data_url: await resolveAttachmentDataUrl({
            data_url: (attachment.data_url as string | null) ?? null,
            storage_bucket: (attachment.storage_bucket as string | null) ?? null,
            storage_path: (attachment.storage_path as string | null) ?? null,
            mime: String(attachment.mime ?? "application/octet-stream"),
          }),
        })),
      );
      return { ...row, message_attachments: resolved };
    }),
  );
}

export async function listMessages(userId: string, conversationId: string, page: PageOptions = {}) {
  await getOwnedConversation(userId, conversationId);
  let query = supabaseAdmin
    .from("messages")
    .select(`${MESSAGE_COLUMNS}, message_attachments(*)`)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(pageSize(page.limit));
  if (page.before) query = query.lt("created_at", page.before);
  const { data, error } = await query;
  if (error) throw new HttpError(500, error.message);
  return withResolvedAttachments([...(data ?? [])].reverse());
}

/**
 * Explicit column list for message reads. Never `select("*")`: `messages.search_tsv` is a generated
 * full-text column (migration 0026) that can be as large as the message itself — returning it made
 * every history load huge and chats open blank on the clients.
 */
export const MESSAGE_COLUMNS =
  "id, conversation_id, role, content, input_mode, created_at, model_label, thinking, citations, agents, used_think, used_search, used_canvas, error, extracted_text, build, files";

const DEFAULT_TITLES = ["New chat", "Auto chat", "Team Up chat"];

/** Gives a still-default-titled conversation a title from its first message (clients only ever set it locally). */
function titleFromMessage(content: string): string {
  const clean = content.replace(/\s+/g, " ").trim();
  return clean.length > 48 ? clean.slice(0, 48).trimEnd() + "…" : clean;
}

async function titleConversationFromFirstMessage(conversationId: string, content: string) {
  const title = titleFromMessage(content);
  if (!title) return;
  const { error } = await supabaseAdmin.from("conversations").update({ title }).eq("id", conversationId).in("title", DEFAULT_TITLES);
  if (error) console.error("[chat] failed to set conversation title:", error.message);
}

export async function insertUserMessage(
  conversationId: string,
  content: string,
  inputMode: "text" | "voice",
  attachments: ChatImage[],
  userId?: string,
) {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .insert({ conversation_id: conversationId, role: "user", content, input_mode: inputMode })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to save message");
  void titleConversationFromFirstMessage(conversationId, content);

  if (attachments.length > 0) {
    const ownerId = userId ?? "anonymous";
    const stored = await storeAttachments(ownerId, data.id as string, attachments);
    const { error: attachmentError } = await supabaseAdmin.from("message_attachments").insert(
      stored.map((attachment) => ({
        message_id: data.id,
        name: attachment.name,
        mime: attachment.mime,
        size_bytes: attachment.size_bytes,
        kind: attachment.kind,
        data_url: attachment.data_url,
        storage_bucket: attachment.storage_bucket,
        storage_path: attachment.storage_path,
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
      build: metadata.build ?? null,
      // Only written when present, so a reply without files never depends on migration 0035.
      ...(metadata.files?.length ? { files: metadata.files } : {}),
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to save reply");
  // Auto-save any code / pages / images in the reply to the user's Library (fire-and-forget).
  void saveFromMessage(conversationId, data.id as string, content);
  return data;
}
