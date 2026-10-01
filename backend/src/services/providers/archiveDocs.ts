import { gunzipSync } from "node:zlib";
import JSZip from "jszip";
import { createExtractorFromData } from "node-unrar-js";
import { extractOfficeBuffer, officeKind } from "./officeDocs.js";
import { extractPdfBuffer } from "./pdfText.js";
import { decodeTextBuffer, isTextFileName } from "./plainTextDocs.js";
import { base64PayloadOf } from "./types.js";

/**
 * Archives (.zip, .rar, .tar, .tar.gz/.tgz, .gz) are opened locally and turned into one text
 * block a model can read: a listing of every entry, then the contents of the readable ones (code,
 * text, Office/OpenDocument, text PDFs). Before this an attached archive was stored and silently
 * never seen by any model.
 *
 * Bounded on every axis — entry count, per-entry size, total extracted text — because an archive is
 * the classic decompression-bomb vector and this runs inside the chat request.
 */
export type ArchiveKind = "zip" | "rar" | "tar" | "tgz" | "gz";

const MAX_ENTRIES_LISTED = 400;
const MAX_ENTRIES_READ = 60;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_UNPACKED = 64 * 1024 * 1024;
const MAX_TEXT_TOTAL = 120_000;
const MAX_TEXT_PER_ENTRY = 20_000;
/** Junk every OS/tool adds to archives — listed nowhere, read never. */
const SKIP = /(^|\/)(__MACOSX|\.git|node_modules|\.DS_Store|Thumbs\.db|\.idea|\.vscode|dist|build|\.next|venv|\.venv|__pycache__)(\/|$)/;

export function archiveKind(mime: string, name?: string): ArchiveKind | null {
  const lower = (name ?? "").toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tgz";
  if (lower.endsWith(".tar")) return "tar";
  if (lower.endsWith(".zip") || mime === "application/zip" || mime === "application/x-zip-compressed") return "zip";
  if (lower.endsWith(".rar") || mime === "application/vnd.rar" || mime === "application/x-rar-compressed" || mime === "application/x-rar") return "rar";
  if (lower.endsWith(".gz") || mime === "application/gzip" || mime === "application/x-gzip") return "gz";
  if (mime === "application/x-tar") return "tar";
  return null;
}

export function isArchive(mime: string, name?: string): boolean {
  return archiveKind(mime, name) !== null;
}

type Entry = { path: string; size: number; read: () => Promise<Buffer> };

async function zipEntries(buffer: Buffer): Promise<Entry[]> {
  const zip = await JSZip.loadAsync(buffer);
  return Object.values(zip.files)
    .filter((f) => !f.dir)
    .map((f) => ({
      path: f.name,
      // JSZip keeps the declared size on the private _data; fall back to "unknown" (0) when absent.
      size: Number((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0),
      read: async () => Buffer.from(await f.async("uint8array")),
    }));
}

async function rarEntries(buffer: Buffer): Promise<Entry[]> {
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const listing = await createExtractorFromData({ data: ab });
  const headers = [...listing.getFileList().fileHeaders].filter((h) => !h.flags.directory);
  // One extraction pass for the small readable entries (unrar can't seek per file cheaply).
  const wanted = headers.filter((h) => h.unpSize <= MAX_ENTRY_BYTES && isReadableName(h.name)).slice(0, MAX_ENTRIES_READ).map((h) => h.name);
  const bodies = new Map<string, Buffer>();
  if (wanted.length) {
    const extractor = await createExtractorFromData({ data: ab });
    const { files } = extractor.extract({ files: wanted });
    for (const file of files) if (file.extraction) bodies.set(file.fileHeader.name, Buffer.from(file.extraction));
  }
  return headers.map((h) => ({
    path: h.name,
    size: h.unpSize,
    read: async () => {
      const body = bodies.get(h.name);
      if (!body) throw new Error("not extracted");
      return body;
    },
  }));
}

/** Minimal POSIX/ustar reader — enough for source tarballs (regular files, GNU long names). */
function tarEntries(buffer: Buffer): Entry[] {
  const out: Entry[] = [];
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, len: number) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8) || 0;
    const type = field(156, 1) || "0";
    const prefix = field(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const start = offset + 512;
    offset = start + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = buffer.subarray(start, start + size).toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    name = name.replace(/^\.\//, "");
    const body = buffer.subarray(start, start + size);
    out.push({ path: name, size, read: async () => Buffer.from(body) });
  }
  return out;
}

function isReadableName(path: string): boolean {
  const lower = path.toLowerCase();
  return !SKIP.test(path) && (isTextFileName(path) || officeKind("", path) !== null || lower.endsWith(".pdf"));
}

async function readEntry(path: string, bytes: Buffer): Promise<string | null> {
  const office = officeKind("", path);
  if (office) return extractOfficeBuffer(bytes, office);
  if (path.toLowerCase().endsWith(".pdf")) return (await extractPdfBuffer(bytes))?.text ?? null;
  return decodeTextBuffer(bytes, MAX_TEXT_PER_ENTRY);
}

function formatSize(n: number): string {
  if (!n) return "";
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Opens an archive's bytes into a listing + readable contents. Throws on a corrupt/encrypted archive. */
export async function extractArchiveBuffer(buffer: Buffer, kind: ArchiveKind, name = "archive"): Promise<string | null> {
  let entries: Entry[];
  if (kind === "zip") entries = await zipEntries(buffer);
  else if (kind === "rar") entries = await rarEntries(buffer);
  else if (kind === "tar") entries = tarEntries(buffer);
  else {
    const unpacked = gunzipSync(buffer, { maxOutputLength: MAX_TOTAL_UNPACKED });
    if (kind === "tgz") entries = tarEntries(unpacked);
    else {
      // A single gzipped file (log.gz, data.csv.gz): it IS the content.
      const inner = name.replace(/\.gz$/i, "");
      const text = await readEntry(inner, unpacked).catch(() => null);
      return text ? `== ${inner} (gzip) ==\n${text}` : null;
    }
  }

  const visible = entries.filter((e) => !SKIP.test(e.path));
  const lines = [`Archive ${name} — ${visible.length} file${visible.length === 1 ? "" : "s"}${entries.length !== visible.length ? ` (${entries.length - visible.length} system/dependency files hidden)` : ""}:`];
  for (const e of visible.slice(0, MAX_ENTRIES_LISTED)) lines.push(`- ${e.path}${e.size ? ` (${formatSize(e.size)})` : ""}`);
  if (visible.length > MAX_ENTRIES_LISTED) lines.push(`- … ${visible.length - MAX_ENTRIES_LISTED} more`);

  let total = 0;
  let unpackedTotal = 0;
  let read = 0;
  const bodies: string[] = [];
  const skipped: string[] = [];
  for (const e of visible) {
    if (!isReadableName(e.path)) continue;
    if (read >= MAX_ENTRIES_READ || total >= MAX_TEXT_TOTAL || e.size > MAX_ENTRY_BYTES || unpackedTotal + e.size > MAX_TOTAL_UNPACKED) {
      skipped.push(e.path);
      continue;
    }
    try {
      const bytes = await e.read();
      unpackedTotal += bytes.length;
      if (bytes.length > MAX_ENTRY_BYTES) {
        skipped.push(e.path);
        continue;
      }
      const text = await readEntry(e.path, bytes);
      if (!text) continue;
      const clipped = text.length > MAX_TEXT_PER_ENTRY ? `${text.slice(0, MAX_TEXT_PER_ENTRY)}\n…(truncated)` : text;
      bodies.push(`== ${e.path} ==\n${clipped}`);
      total += clipped.length;
      read++;
    } catch {
      skipped.push(e.path);
    }
  }
  if (skipped.length) lines.push(`\n(Not read to stay within limits: ${skipped.slice(0, 30).join(", ")}${skipped.length > 30 ? ", …" : ""})`);
  return [lines.join("\n"), ...bodies].join("\n\n");
}

/** Best-effort for a chat attachment: never throws, null when it can't be opened. */
export async function extractArchiveText(dataUrl: string, mime: string, name?: string): Promise<string | null> {
  const kind = archiveKind(mime, name);
  if (!kind) return null;
  try {
    return await extractArchiveBuffer(Buffer.from(base64PayloadOf(dataUrl), "base64"), kind, name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return /password|encrypt/i.test(message) ? `Archive ${name ?? ""} is password-protected — it can't be opened without the password.` : null;
  }
}
