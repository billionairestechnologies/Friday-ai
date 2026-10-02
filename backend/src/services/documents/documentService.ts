import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { logger } from "../../utils/logger.js";
import { consumeDailyAllowance, entitlementsFor, refundDailyAllowance } from "../quota/entitlements.js";
import { FORMAT_MIME, codeExtension, describeSpec, renderDocument, type DocFormat, type DocumentSpec } from "./render.js";

/**
 * Generated documents: render → store → hand back a file record the chat shows as a download card
 * and the Library lists. Each document counts against the plan's documentsPerDay entitlement and
 * the Library storage allowance (libraryStorageMb), both checked BEFORE rendering.
 */

export const DOCUMENTS_BUCKET = "generated-files";
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export type GeneratedFile = {
  id: string;
  title: string;
  filename: string;
  /** "page" = a live Friday page (services/pages), shown as an Open card instead of a download. */
  format: DocFormat | "page";
  size: number;
  summary: string;
  createdAt: string;
  pageKind?: "doc" | "sheet" | "slides";
};

export function safeFilename(name: string, format: DocFormat, extension?: string | null): string {
  const base = name
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return `${base || "document"}.${format === "txt" && extension ? extension : format}`;
}

export async function storageUsedBytes(userId: string): Promise<number> {
  const { data } = await supabaseAdmin.from("generated_files").select("size_bytes").eq("user_id", userId).is("deleted_at", null).limit(5000);
  return (data ?? []).reduce((n, r) => n + Number(r.size_bytes ?? 0), 0);
}

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { error } = await supabaseAdmin.storage.createBucket(DOCUMENTS_BUCKET, { public: false, fileSizeLimit: MAX_FILE_BYTES });
  // "already exists" is the normal case after the first run.
  if (error && !/exist/i.test(error.message)) throw new Error(error.message);
  bucketReady = true;
}

export async function createDocument(userId: string, conversationId: string | null, spec: DocumentSpec): Promise<GeneratedFile> {
  const entitlements = await entitlementsFor(userId);
  const allowance = await consumeDailyAllowance(userId, "documents", entitlements.documentsPerDay);
  if (!allowance.ok) {
    throw new HttpError(429, allowance.limit > 0
      ? `Daily document limit reached (${allowance.limit} a day on this plan) — it resets at midnight UTC, or upgrade for more.`
      : "Document creation isn't included in this plan — upgrade to create files.");
  }
  try {
    const bytes = await renderDocument(spec);
    if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, "That document is too large (over 25 MB) — split it into smaller files.");
    const limitBytes = entitlements.libraryStorageMb * 1024 * 1024;
    if ((await storageUsedBytes(userId)) + bytes.length > limitBytes) {
      throw new HttpError(413, `Your Library is full (${entitlements.libraryStorageMb >= 1024 ? `${Math.round(entitlements.libraryStorageMb / 1024)} GB` : `${entitlements.libraryStorageMb} MB`}). Delete some files in the Library or upgrade for more space.`);
    }
    const filename = safeFilename(spec.title, spec.format, codeExtension(spec.extension));
    const id = randomUUID();
    let storage: { bucket: string; path: string } | null = null;
    if (env.attachmentObjectStorageEnabled) {
      try {
        await ensureBucket();
        const path = `${userId}/${id}/${filename}`;
        const { error } = await supabaseAdmin.storage.from(DOCUMENTS_BUCKET).upload(path, bytes, { contentType: FORMAT_MIME[spec.format], upsert: false });
        if (error) throw new Error(error.message);
        storage = { bucket: DOCUMENTS_BUCKET, path };
      } catch (err) {
        // Storage trouble shouldn't cost the user their document — keep it inline instead.
        logger.warn("generated_file_upload_failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    const summary = describeSpec(spec);
    const { data, error } = await supabaseAdmin
      .from("generated_files")
      .insert({
        id,
        user_id: userId,
        conversation_id: conversationId,
        format: spec.format,
        title: spec.title.slice(0, 200),
        filename,
        mime: FORMAT_MIME[spec.format],
        size_bytes: bytes.length,
        summary,
        storage_bucket: storage?.bucket ?? null,
        storage_path: storage?.path ?? null,
        content_b64: storage ? null : bytes.toString("base64"),
      })
      .select("id, title, filename, format, size_bytes, summary, created_at")
      .single();
    if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't save the document");
    return { id: data.id as string, title: data.title as string, filename: data.filename as string, format: data.format as DocFormat, size: Number(data.size_bytes), summary: data.summary as string, createdAt: data.created_at as string };
  } catch (err) {
    // Nothing was delivered — don't count it against today's allowance.
    await refundDailyAllowance(userId, "documents").catch(() => {});
    throw err;
  }
}

export async function listFiles(userId: string, limit = 300) {
  const { data, error } = await supabaseAdmin
    .from("generated_files")
    .select("id, conversation_id, title, filename, format, size_bytes, summary, created_at")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return []; // before migration 0035
  return data ?? [];
}

export async function fileBytes(userId: string, id: string): Promise<{ bytes: Buffer; filename: string; mime: string }> {
  const { data, error } = await supabaseAdmin
    .from("generated_files")
    .select("filename, mime, storage_bucket, storage_path, content_b64")
    .eq("id", id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "File not found");
  if (data.storage_bucket && data.storage_path) {
    const { data: blob, error: dlError } = await supabaseAdmin.storage.from(data.storage_bucket as string).download(data.storage_path as string);
    if (dlError || !blob) throw new HttpError(502, "Couldn't fetch the file from storage");
    return { bytes: Buffer.from(await blob.arrayBuffer()), filename: data.filename as string, mime: data.mime as string };
  }
  return { bytes: Buffer.from(String(data.content_b64 ?? ""), "base64"), filename: data.filename as string, mime: data.mime as string };
}

export async function deleteFile(userId: string, id: string) {
  const { data } = await supabaseAdmin.from("generated_files").select("storage_bucket, storage_path").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw new HttpError(404, "File not found");
  // Soft delete keeps message cards consistent ("file deleted"); the bytes go now, freeing storage.
  if (data.storage_bucket && data.storage_path) await supabaseAdmin.storage.from(data.storage_bucket as string).remove([data.storage_path as string]).catch(() => {});
  const { error } = await supabaseAdmin.from("generated_files").update({ deleted_at: new Date().toISOString(), content_b64: null, size_bytes: 0 }).eq("id", id).eq("user_id", userId);
  if (error) throw new HttpError(500, error.message);
}
