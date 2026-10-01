import mammoth from "mammoth";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { base64PayloadOf } from "./types.js";

// DOCX/XLSX/PPTX and OpenDocument (ODT/ODS/ODP) are structured XML-in-a-zip formats, not scanned
// documents — there's nothing to OCR, so this parses them directly instead of routing through
// Sarvam's Doc AI (which doesn't accept them at all, confirmed directly against the real API: a
// DOCX zip was rejected outright, "only JPEG and PNG entries are allowed"). No external API/key
// needed, and no job upload/poll round trip like the PDF/image path.
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const ODT_MIME = "application/vnd.oasis.opendocument.text";
const ODS_MIME = "application/vnd.oasis.opendocument.spreadsheet";
const ODP_MIME = "application/vnd.oasis.opendocument.presentation";

export type OfficeKind = "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp";
const BY_MIME: Record<string, OfficeKind> = { [DOCX_MIME]: "docx", [XLSX_MIME]: "xlsx", [PPTX_MIME]: "pptx", [ODT_MIME]: "odt", [ODS_MIME]: "ods", [ODP_MIME]: "odp" };
const KINDS = new Set<OfficeKind>(["docx", "xlsx", "pptx", "odt", "ods", "odp"]);

/** The office format of a file, from its mime or (browsers often send application/octet-stream) its extension. */
export function officeKind(mime: string, name?: string): OfficeKind | null {
  if (BY_MIME[mime]) return BY_MIME[mime]!;
  const ext = name?.split(".").pop()?.toLowerCase() as OfficeKind | undefined;
  return ext && KINDS.has(ext) ? ext : null;
}

export function isOfficeDocument(mime: string, name?: string): boolean {
  return officeKind(mime, name) !== null;
}

async function extractDocx(buffer: Buffer): Promise<string | null> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value.trim() || null;
}

async function extractXlsx(buffer: Buffer): Promise<string | null> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const sheets: string[] = [];
  workbook.eachSheet((worksheet) => {
    const rows: string[] = [];
    worksheet.eachRow((row, rowNumber) => {
      // row.values is 1-indexed (index 0 is unused), and each cell may itself be an object
      // (formula results, rich text) rather than a plain scalar — normalize defensively.
      // Formulas are kept next to their value: "deep analysis" of a model needs to see HOW a
      // number is computed, not just the cached result.
      const cells = (row.values as unknown[]).slice(1).map((v) => {
        if (v === null || v === undefined) return "";
        if (typeof v === "object" && "formula" in (v as Record<string, unknown>)) {
          const f = v as { formula: string; result?: unknown };
          return `${String(f.result ?? "")} [=${f.formula}]`;
        }
        if (typeof v === "object" && "result" in (v as Record<string, unknown>)) return String((v as { result: unknown }).result ?? "");
        if (typeof v === "object" && "richText" in (v as Record<string, unknown>)) {
          return ((v as { richText: { text: string }[] }).richText).map((r) => r.text).join("");
        }
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        return String(v);
      });
      rows.push(`${rowNumber}: ${cells.join(" | ")}`);
    });
    if (rows.length > 0) sheets.push(`== Sheet: ${worksheet.name} ==\n${rows.join("\n")}`);
  });

  const text = sheets.join("\n\n").trim();
  return text || null;
}

/** Text runs of an XML part, paragraph by paragraph (PPTX <a:p>/<a:t>, OpenDocument <text:p>). */
function xmlText(xml: string, paragraph: RegExp, run: RegExp): string {
  const out: string[] = [];
  for (const p of xml.match(paragraph) ?? []) {
    const line = [...p.matchAll(run)].map((m) => decodeXml(m[1] ?? "")).join("");
    if (line.trim()) out.push(line);
  }
  return out.join("\n");
}

function decodeXml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

async function extractPptx(buffer: Buffer): Promise<string | null> {
  const zip = await JSZip.loadAsync(buffer);
  const slideNo = (p: string) => Number(p.match(/(\d+)\.xml$/)?.[1] ?? 0);
  const slides = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => slideNo(a) - slideNo(b));
  const parts: string[] = [];
  for (const path of slides) {
    const n = slideNo(path);
    const body = xmlText(await zip.file(path)!.async("string"), /<a:p\b[\s\S]*?<\/a:p>/g, /<a:t>([\s\S]*?)<\/a:t>/g);
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    const notes = notesFile ? xmlText(await notesFile.async("string"), /<a:p\b[\s\S]*?<\/a:p>/g, /<a:t>([\s\S]*?)<\/a:t>/g) : "";
    parts.push(`== Slide ${n} ==\n${body}${notes.trim() ? `\n[Speaker notes] ${notes}` : ""}`);
  }
  return parts.join("\n\n").trim() || null;
}

async function extractOpenDocument(buffer: Buffer): Promise<string | null> {
  const zip = await JSZip.loadAsync(buffer);
  const content = await zip.file("content.xml")?.async("string");
  if (!content) return null;
  // Table cells and headings/paragraphs both carry their text in text:p / text:h.
  return xmlText(content, /<text:(?:p|h)\b[\s\S]*?<\/text:(?:p|h)>/g, /([\s\S]+)/g).trim() || null;
}

/** Extracts text from an office file's raw bytes. Throws on a corrupt file (callers decide how to report it). */
export async function extractOfficeBuffer(buffer: Buffer, kind: OfficeKind): Promise<string | null> {
  switch (kind) {
    case "docx":
      return extractDocx(buffer);
    case "xlsx":
      return extractXlsx(buffer);
    case "pptx":
      return extractPptx(buffer);
    default:
      return extractOpenDocument(buffer);
  }
}

/**
 * Extracts text/data from an office attachment. Unlike the PDF/image path, this always works (or
 * fails outright with a real error) regardless of which model answers — it's plain local parsing,
 * no provider dependency. Returns null (never throws) on a corrupt/unparseable file, consistent
 * with the best-effort contract of digitiseDocument().
 */
export async function extractOfficeText(dataUrl: string, mime: string, name?: string): Promise<string | null> {
  const kind = officeKind(mime, name);
  if (!kind) return null;
  try {
    return await extractOfficeBuffer(Buffer.from(base64PayloadOf(dataUrl), "base64"), kind);
  } catch {
    return null;
  }
}
