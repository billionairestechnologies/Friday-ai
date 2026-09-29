import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { resolveAttachmentDataUrl } from "./attachmentStorage.js";
import { listFiles } from "./documents/documentService.js";

export type LibraryCategory =
  | "Web pages"
  | "React"
  | "Python"
  | "JavaScript / TypeScript"
  | "Shell"
  | "SQL"
  | "Styles"
  | "Data"
  | "Other code"
  | "Images";

/** Categories that aren't extracted from replies: generated documents and the user's own uploads. */
export const VIRTUAL_CATEGORIES = ["Documents", "Uploads"] as const;

export const LIBRARY_CATEGORIES: LibraryCategory[] = [
  "Web pages",
  "React",
  "Python",
  "JavaScript / TypeScript",
  "Shell",
  "SQL",
  "Styles",
  "Data",
  "Other code",
  "Images",
];

type Extracted = { kind: string; lang: string | null; category: LibraryCategory; title: string; content: string };

const FENCE = /```([\w+-]*)[^\n]*\n([\s\S]*?)```/g;
const SKIP_LANGS = new Set(["text", "txt", "plaintext", "markdown", "md", "console", "output", "diff", "log", "mermaid"]);

function looksLikeReact(body: string) {
  return (
    /<([A-Za-z][\w.]*)[^>]*>[\s\S]*<\/\1>/.test(body) &&
    /\b(useState|useEffect|useRef|useMemo|useCallback|export default|return\s*\()/.test(body)
  );
}

function classify(lang: string, body: string): { kind: string; category: LibraryCategory } {
  const l = lang.toLowerCase();
  if (l === "html") return { kind: "html", category: "Web pages" };
  if (l === "jsx" || l === "tsx" || (["js", "javascript", "ts", "typescript"].includes(l) && looksLikeReact(body))) {
    return { kind: "react", category: "React" };
  }
  if (["python", "py"].includes(l)) return { kind: "code", category: "Python" };
  if (["js", "javascript", "ts", "typescript", "node"].includes(l)) return { kind: "code", category: "JavaScript / TypeScript" };
  if (["bash", "sh", "shell", "zsh"].includes(l)) return { kind: "code", category: "Shell" };
  if (l === "sql") return { kind: "code", category: "SQL" };
  if (["css", "scss", "sass", "less"].includes(l)) return { kind: "code", category: "Styles" };
  if (["json", "yaml", "yml", "xml", "csv", "toml"].includes(l)) return { kind: "data", category: "Data" };
  return { kind: "code", category: "Other code" };
}

function deriveTitle(lang: string, body: string, category: LibraryCategory): string {
  const htmlTitle = body.match(/<title>([^<]{1,80})<\/title>/i)?.[1]?.trim();
  if (htmlTitle) return htmlTitle;
  const h1 = body.match(/<h1[^>]*>([^<]{1,80})<\/h1>/i)?.[1]?.trim();
  if (h1) return h1;
  const comment = body.match(/^\s*(?:\/\/|#|\/\*+|--)\s*(.{3,80}?)\s*(?:\*\/)?\s*$/m)?.[1];
  if (comment) return comment;
  const decl = body.match(/(?:function|class|def|const|export default function)\s+([A-Za-z_]\w*)/)?.[1];
  if (decl) return `${category === "Other code" ? lang || "Code" : category}: ${decl}`;
  const first = body.split("\n").find((line) => line.trim())?.trim().slice(0, 60);
  return first ? `${lang || "Code"}: ${first}` : lang || "Code";
}

export function extractLibraryItems(content: string): Extracted[] {
  const items: Extracted[] = [];
  for (const match of content.matchAll(FENCE)) {
    const lang = (match[1] ?? "").trim();
    const body = (match[2] ?? "").trim();
    if (!body || SKIP_LANGS.has(lang.toLowerCase())) continue;
    // Skip trivial one-liners (a shell command, a snippet inline in prose) — not worth a library entry.
    if (body.split("\n").length < 3 && body.length < 80) continue;
    const { kind, category } = classify(lang, body);
    items.push({ kind, lang: lang || null, category, title: deriveTitle(lang, body, category), content: body });
  }
  for (const img of content.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/g)) {
    items.push({
      kind: "image",
      lang: null,
      category: "Images",
      title: (img[1] ?? "").trim().slice(0, 80) || "Generated image",
      content: img[2] ?? "",
    });
  }
  return items;
}

async function insertItems(userId: string, conversationId: string, messageId: string, content: string) {
  const items = extractLibraryItems(content);
  if (!items.length) return;
  const rows = items.map((item, idx) => ({
    user_id: userId,
    conversation_id: conversationId,
    message_id: messageId,
    idx,
    ...item,
  }));
  // ignoreDuplicates: a re-save (or the backfill) must never overwrite or un-delete an existing row.
  const { error } = await supabaseAdmin
    .from("library_items")
    .upsert(rows, { onConflict: "message_id,idx", ignoreDuplicates: true });
  if (error) console.error("[library] save failed:", error.message);
}

/** Called right after an assistant reply is persisted. Never throws — the library is a side
 *  effect and must not fail the chat turn. */
export async function saveFromMessage(conversationId: string, messageId: string, content: string) {
  try {
    if (!content.includes("```") && !content.includes("![")) return;
    const { data } = await supabaseAdmin.from("conversations").select("user_id").eq("id", conversationId).single();
    if (data?.user_id) await insertItems(data.user_id as string, conversationId, messageId, content);
  } catch (err) {
    console.error("[library] save failed:", err instanceof Error ? err.message : err);
  }
}

/** One-time import of a user's existing chats the first time they open the Library. */
async function backfill(userId: string) {
  const { data: convs } = await supabaseAdmin.from("conversations").select("id").eq("user_id", userId);
  const ids = (convs ?? []).map((c) => c.id as string);
  if (!ids.length) return;
  const { data: msgs } = await supabaseAdmin
    .from("messages")
    .select("id, conversation_id, content")
    .in("conversation_id", ids)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(500);
  for (const m of msgs ?? []) {
    await insertItems(userId, m.conversation_id as string, m.id as string, String(m.content ?? ""));
  }
}

const LIST_FIELDS = "id, conversation_id, title, kind, lang, category, created_at";

export async function listItems(userId: string, category?: string) {
  const { count } = await supabaseAdmin
    .from("library_items")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (!count) await backfill(userId);

  let query = supabaseAdmin
    .from("library_items")
    .select(`${LIST_FIELDS}, content`)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(300);
  if (category) query = query.eq("category", category);
  const { data, error } = await query;
  if (error) throw new HttpError(500, error.message);
  // Lists carry only a short preview; the full body comes from getItem.
  return (data ?? []).map(({ content, ...rest }) => ({
    ...rest,
    preview: rest.kind === "image" ? String(content) : String(content).slice(0, 240),
  }));
}

export type LibraryEntry = {
  id: string;
  source: "artifact" | "document" | "upload";
  conversation_id: string | null;
  title: string;
  kind: string;
  lang: string | null;
  category: string;
  created_at: string;
  preview: string;
  size?: number;
  filename?: string;
  mime?: string;
};

async function listUploads(userId: string, limit = 200): Promise<LibraryEntry[]> {
  const { data, error } = await supabaseAdmin
    .from("message_attachments")
    .select("id, name, mime, size_bytes, kind, created_at, messages!inner(conversation_id, conversations!inner(user_id))")
    .eq("messages.conversations.user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []).map((row) => {
    const message = (Array.isArray(row.messages) ? row.messages[0] : row.messages) as { conversation_id?: string } | null;
    return {
      id: row.id as string,
      source: "upload" as const,
      conversation_id: message?.conversation_id ?? null,
      title: row.name as string,
      kind: row.kind === "image" ? "image" : "file",
      lang: null,
      category: "Uploads",
      created_at: row.created_at as string,
      preview: "",
      size: Number(row.size_bytes ?? 0),
      mime: row.mime as string,
    };
  });
}

/**
 * Everything a user made or shared, in one place: code / pages / images extracted from replies,
 * generated documents, and files they uploaded — newest first, optionally one category.
 */
export async function listLibrary(userId: string, category?: string): Promise<LibraryEntry[]> {
  const wantArtifacts = !category || !(VIRTUAL_CATEGORIES as readonly string[]).includes(category);
  const [artifacts, documents, uploads] = await Promise.all([
    wantArtifacts ? listItems(userId, category) : Promise.resolve([]),
    !category || category === "Documents" ? listFiles(userId) : Promise.resolve([]),
    !category || category === "Uploads" ? listUploads(userId) : Promise.resolve([]),
  ]);
  const entries: LibraryEntry[] = [
    ...artifacts.map((a) => ({ ...(a as Omit<LibraryEntry, "source">), source: "artifact" as const })),
    ...documents.map((d) => ({
      id: d.id as string,
      source: "document" as const,
      conversation_id: (d.conversation_id as string | null) ?? null,
      title: d.title as string,
      kind: "document",
      lang: d.format as string,
      category: "Documents",
      created_at: d.created_at as string,
      preview: d.summary as string,
      size: Number(d.size_bytes ?? 0),
      filename: d.filename as string,
    })),
    ...uploads,
  ];
  return entries.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 600);
}

/** A viewable URL for one of the user's uploads (signed, short-lived) — ownership checked. */
export async function uploadUrl(userId: string, id: string): Promise<{ url: string; name: string; mime: string }> {
  const { data, error } = await supabaseAdmin
    .from("message_attachments")
    .select("name, mime, data_url, storage_bucket, storage_path, messages!inner(conversations!inner(user_id))")
    .eq("id", id)
    .eq("messages.conversations.user_id", userId)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Upload not found");
  const row = data as unknown as { name: string; mime: string; data_url: string | null; storage_bucket: string | null; storage_path: string | null };
  return { url: await resolveAttachmentDataUrl(row), name: row.name, mime: row.mime };
}

export async function getItem(userId: string, id: string) {
  const { data, error } = await supabaseAdmin
    .from("library_items")
    .select(`${LIST_FIELDS}, content`)
    .eq("id", id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Library item not found");
  return data;
}

export async function deleteItem(userId: string, id: string) {
  const { error } = await supabaseAdmin
    .from("library_items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw new HttpError(500, error.message);
}
