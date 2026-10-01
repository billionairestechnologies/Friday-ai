import { extractText, getDocumentProxy } from "unpdf";
import { base64PayloadOf } from "./types.js";

/**
 * Local text extraction for PDFs that HAVE a text layer (almost every exported report, invoice,
 * statement, paper). Instant and free, and it works for every model — before this a PDF only
 * became readable through Sarvam's OCR (needs a Sarvam key, a job round trip) or a provider's own
 * native PDF support. Scanned PDFs (no text layer) still go to OCR: `scanned` tells the caller.
 */
const MAX_PDF_CHARS = 120_000;
const MAX_PAGES = 300;

export async function extractPdfBuffer(buffer: Buffer): Promise<{ text: string; pages: number; scanned: boolean } | null> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const pages = pdf.numPages;
  const { text } = await extractText(pdf, { mergePages: false });
  const perPage = (Array.isArray(text) ? text : [text]).slice(0, MAX_PAGES);
  const chars = perPage.reduce((n, t) => n + t.trim().length, 0);
  // Under ~30 characters a page is a scan (or a pure image PDF) — OCR will do better.
  const scanned = chars < Math.max(30, pages * 30);
  if (!chars) return { text: "", pages, scanned: true };
  let joined = perPage.map((t, i) => `--- Page ${i + 1} ---\n${t.trim()}`).join("\n\n");
  if (joined.length > MAX_PDF_CHARS) joined = `${joined.slice(0, MAX_PDF_CHARS)}\n…(truncated — ${pages} pages in total)`;
  if (pages > MAX_PAGES) joined += `\n…(only the first ${MAX_PAGES} of ${pages} pages were read)`;
  return { text: joined, pages, scanned };
}

/** Best-effort: null for a corrupt/encrypted PDF or one without a usable text layer. */
export async function extractPdfText(dataUrl: string): Promise<{ text: string; scanned: boolean } | null> {
  try {
    return await extractPdfBuffer(Buffer.from(base64PayloadOf(dataUrl), "base64"));
  } catch {
    return null;
  }
}
