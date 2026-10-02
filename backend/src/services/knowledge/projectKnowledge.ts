import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { logger } from "../../utils/logger.js";
import { getWorkingKeyForProvider } from "../providerService.js";
import { getOwnedProject } from "../projectService.js";
import { archiveKind, extractArchiveBuffer } from "../providers/archiveDocs.js";
import { extractOfficeBuffer, officeKind } from "../providers/officeDocs.js";
import { extractPdfBuffer } from "../providers/pdfText.js";
import { decodeTextBuffer, isPlainTextDocument } from "../providers/plainTextDocs.js";
import { digitiseDocument, isDigitisable } from "../providers/sarvamDocAI.js";
import { chunkText } from "./chunking.js";
import { getEmbedder, toVectorLiteral } from "./embeddings.js";

/**
 * Project knowledge: files added to a project are read once, chunked and indexed (full-text +
 * vectors), and every chat in the project can search them with the `search_project_files` tool —
 * like Claude's project knowledge. Before this a project only had a free-text "instructions" box;
 * a file had to be re-attached to every chat and only that chat could see it.
 */

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;
const MAX_FILES_PER_PROJECT = 200;
const EMBED_BATCH = 64;

export async function listProjectFiles(userId: string, projectId: string) {
  await getOwnedProject(userId, projectId);
  const { data, error } = await supabaseAdmin
    .from("project_files")
    .select("id, filename, mime, size_bytes, status, error, chunk_count, char_count, embedded, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

/** Any readable format → plain text (same readers chat attachments use, all local except image OCR). */
export async function extractText(buffer: Buffer, filename: string, mime: string): Promise<string> {
  const office = officeKind(mime, filename);
  if (office) return (await extractOfficeBuffer(buffer, office)) ?? "";
  const archive = archiveKind(mime, filename);
  if (archive) return (await extractArchiveBuffer(buffer, archive, filename)) ?? "";
  if (mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
    const local = await extractPdfBuffer(buffer).catch(() => null);
    if (local && !local.scanned) return local.text;
    const key = await getWorkingKeyForProvider("sarvam").catch(() => null);
    const ocr = key ? await digitiseDocument(key, `data:application/pdf;base64,${buffer.toString("base64")}`, "application/pdf", filename) : null;
    return ocr ?? local?.text ?? "";
  }
  if (isDigitisable(mime)) {
    const key = await getWorkingKeyForProvider("sarvam").catch(() => null);
    if (!key) throw new HttpError(400, "Reading text from images needs the Sarvam OCR key on this server.");
    return (await digitiseDocument(key, `data:${mime};base64,${buffer.toString("base64")}`, mime, filename)) ?? "";
  }
  if (isPlainTextDocument(mime, filename) || mime === "application/octet-stream") return decodeTextBuffer(buffer, MAX_TEXT_CHARS) ?? "";
  throw new HttpError(400, `Friday can't read ${filename} yet — try PDF, Word, Excel, PowerPoint, text, code or a zip.`);
}

/** Adds a file: stores the row right away (status processing) and indexes it in the background. */
export async function addProjectFile(userId: string, projectId: string, file: { filename: string; mime: string; buffer: Buffer }) {
  await getOwnedProject(userId, projectId);
  if (file.buffer.length > MAX_FILE_BYTES) throw new HttpError(413, "Files up to 20 MB can be added to a project.");
  const { count } = await supabaseAdmin.from("project_files").select("id", { count: "exact", head: true }).eq("project_id", projectId);
  if ((count ?? 0) >= MAX_FILES_PER_PROJECT) throw new HttpError(400, `A project holds up to ${MAX_FILES_PER_PROJECT} files — remove some first.`);
  const { data: row, error } = await supabaseAdmin
    .from("project_files")
    .insert({ project_id: projectId, user_id: userId, filename: file.filename.slice(0, 255), mime: file.mime || "application/octet-stream", size_bytes: file.buffer.length })
    .select("id, filename, mime, size_bytes, status, created_at")
    .single();
  if (error || !row) throw new HttpError(500, error?.message ?? "Couldn't add the file");
  void indexFile(row.id as string, projectId, file).catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("project_file_index_failed", { fileId: row.id, error: message });
    await supabaseAdmin.from("project_files").update({ status: "error", error: message.slice(0, 500) }).eq("id", row.id);
  });
  return row;
}

async function indexFile(fileId: string, projectId: string, file: { filename: string; mime: string; buffer: Buffer }) {
  let text = await extractText(file.buffer, file.filename, file.mime);
  if (!text.trim()) throw new Error("No readable text found in this file (a scanned image without OCR?)");
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
  const chunks = chunkText(text);
  // Each chunk is prefixed with its file name: "which file said this" is part of what a search matches.
  const contents = chunks.map((c) => `[${file.filename}]\n${c}`);
  const embedder = await getEmbedder();
  let embedded = Boolean(embedder);
  for (let i = 0; i < contents.length; i += EMBED_BATCH) {
    const batch = contents.slice(i, i + EMBED_BATCH);
    let vectors: number[][] | null = null;
    if (embedder && embedded) {
      vectors = await embedder.embed(batch, "document").catch((err) => {
        // Keep indexing text-only rather than failing the whole file on an embedding outage.
        logger.warn("project_embed_failed", { fileId, error: err instanceof Error ? err.message : String(err) });
        embedded = false;
        return null;
      });
    }
    const rows = batch.map((content, j) => ({
      file_id: fileId,
      project_id: projectId,
      chunk_index: i + j,
      content,
      embedding: vectors?.[j] ? toVectorLiteral(vectors[j]!) : null,
      embed_model: vectors?.[j] ? embedder!.model : null,
    }));
    const { error } = await supabaseAdmin.from("project_chunks").insert(rows);
    if (error) throw new Error(error.message);
  }
  await supabaseAdmin.from("project_files").update({ status: "ready", chunk_count: contents.length, char_count: text.length, embedded, error: null }).eq("id", fileId);
}

export async function deleteProjectFile(userId: string, projectId: string, fileId: string) {
  await getOwnedProject(userId, projectId);
  const { error } = await supabaseAdmin.from("project_files").delete().eq("id", fileId).eq("project_id", projectId);
  if (error) throw new HttpError(500, error.message);
}

export type KnowledgeHit = { fileId: string; filename: string; chunkIndex: number; content: string; score: number };

/** Hybrid search over a project's files (full-text + vectors fused). */
export async function searchProject(projectId: string, query: string, limit = 8): Promise<KnowledgeHit[]> {
  const q = query.trim().slice(0, 1000);
  if (!q) return [];
  // Embed the query with the model most of the project's chunks were embedded with.
  const { data: sample } = await supabaseAdmin.from("project_chunks").select("embed_model").eq("project_id", projectId).not("embed_model", "is", null).limit(1).maybeSingle();
  const embedder = sample?.embed_model ? await getEmbedder(sample.embed_model as string) : null;
  const vector = embedder ? await embedder.embed([q], "query").then((v) => v[0] ?? null).catch(() => null) : null;
  const { data, error } = await supabaseAdmin.rpc("search_project_chunks", {
    p_project: projectId,
    p_query: q,
    p_embedding: vector ? toVectorLiteral(vector) : null,
    p_embed_model: vector ? embedder!.model : null,
    p_limit: limit,
  });
  if (error) throw new HttpError(500, `Project search failed: ${error.message}`);
  return ((data ?? []) as { file_id: string; filename: string; chunk_index: number; content: string; score: number }[]).map((r) => ({
    fileId: r.file_id,
    filename: r.filename,
    chunkIndex: r.chunk_index,
    content: r.content,
    score: Number(r.score),
  }));
}

/** Ready file names for the system prompt ("this project has: …"), or [] when none. */
export async function readyFileNames(projectId: string): Promise<string[]> {
  const { data } = await supabaseAdmin.from("project_files").select("filename").eq("project_id", projectId).eq("status", "ready").limit(200);
  return (data ?? []).map((r) => r.filename as string);
}
