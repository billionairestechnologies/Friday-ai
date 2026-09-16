import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { base64PayloadOf } from "./types.js";

// DOCX/XLSX are structured XML formats, not scanned documents — there's nothing to OCR, so this
// parses them directly instead of routing through Sarvam's Doc AI (which doesn't accept them at
// all, confirmed directly against the real API: a DOCX zip was rejected outright, "only JPEG
// and PNG entries are allowed"). No external API/key needed, and it's synchronous — no job
// upload/poll round trip like the PDF/image path.
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const OFFICE_MIMES = new Set([DOCX_MIME, XLSX_MIME]);

export function isOfficeDocument(mime: string): boolean {
  return OFFICE_MIMES.has(mime);
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
    worksheet.eachRow((row) => {
      // row.values is 1-indexed (index 0 is unused), and each cell may itself be an object
      // (formula results, rich text) rather than a plain scalar — normalize defensively.
      const cells = (row.values as unknown[]).slice(1).map((v) => {
        if (v === null || v === undefined) return "";
        if (typeof v === "object" && "result" in (v as Record<string, unknown>)) return String((v as { result: unknown }).result ?? "");
        if (typeof v === "object" && "richText" in (v as Record<string, unknown>)) {
          return ((v as { richText: { text: string }[] }).richText).map((r) => r.text).join("");
        }
        return String(v);
      });
      rows.push(cells.join(", "));
    });
    if (rows.length > 0) sheets.push(`== Sheet: ${worksheet.name} ==\n${rows.join("\n")}`);
  });

  const text = sheets.join("\n\n").trim();
  return text || null;
}

/**
 * Extracts text/data from a DOCX or XLSX attachment. Unlike the PDF/image path, this always
 * works (or fails outright with a real error) regardless of which model answers — it's plain
 * local parsing, no provider dependency, so there's no "unsupported provider" gate needed for
 * these formats. Returns null (never throws) on a corrupt/unparseable file, consistent with the
 * best-effort contract of digitiseDocument().
 */
export async function extractOfficeText(dataUrl: string, mime: string): Promise<string | null> {
  if (!isOfficeDocument(mime)) return null;
  try {
    const buffer = Buffer.from(base64PayloadOf(dataUrl), "base64");
    if (mime === DOCX_MIME) return await extractDocx(buffer);
    return await extractXlsx(buffer);
  } catch {
    return null;
  }
}
