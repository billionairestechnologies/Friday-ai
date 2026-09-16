import { base64PayloadOf } from "./types.js";

const BASE_URL = "https://api.sarvam.ai/doc-ai/v1";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000;

// Verified directly against the real API (2026-09-16): the digitise endpoint accepts PDF, PNG,
// and JPEG. A DOCX (itself a zip of XML parts) was rejected outright — "only JPEG (.jpg, .jpeg)
// and PNG (.png) entries are allowed" — so its "ZIP archive" support (per Sarvam's own docs)
// means a zip of scanned image pages, not Office documents. There's no path to "any document"
// here; PDF/PNG/JPEG is the real ceiling.
const SUPPORTED_MIMES = new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg"]);

export function isDigitisable(mime: string): boolean {
  return SUPPORTED_MIMES.has(mime);
}

interface DigitiseJobResponse {
  job_id: string;
  status: string;
}

interface DigitiseStatusResponse {
  status: string;
}

interface DigitiseBlock {
  text: string;
  reading_order: number;
}

interface DigitisePage {
  page_num: number;
  blocks: DigitiseBlock[];
}

interface DigitiseDocument {
  filename: string;
  pages: DigitisePage[];
}

interface DigitiseResultsResponse {
  status: string;
  documents: DigitiseDocument[];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a PDF or image through Sarvam's Doc AI digitise pipeline (real OCR/layout extraction,
 * verified live against the actual API — not the same thing as the gated Gemma4 vision beta on
 * Sarvam's main chat endpoint) and returns its text content in reading order. This is what makes
 * a file usable by ANY chat model, not just ones with native document/vision support: the file
 * never has to reach the LLM at all, only as plain extracted text folded into the message — see
 * appendExtractedText() in promptContext.ts. For images this runs *alongside* native vision (not
 * instead of it) — genuine OCR text is often more exact/reliable than a vision model reading text
 * out of an image, and it's the only way a non-vision model gets to "read" one at all.
 *
 * Low-resolution images can come back with zero extracted blocks even when the text is legible
 * to a human (confirmed directly: a 612×792 render of a short sentence extracted nothing, the
 * same content re-rendered at 1236×1600 extracted it exactly) — treat an empty result as "OCR
 * found nothing usable" rather than "the API is broken."
 *
 * Returns null (never throws) on any failure — extraction is a best-effort enhancement, and a
 * file that fails to digitise should fall back to whatever native support the chosen model has,
 * not blow up the whole request.
 */
export async function digitiseDocument(apiKey: string, dataUrl: string, mime: string, filename: string): Promise<string | null> {
  if (!isDigitisable(mime)) return null;
  try {
    const bytes = Buffer.from(base64PayloadOf(dataUrl), "base64");
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), filename);
    form.append("output_format", "md");

    const createRes = await fetch(`${BASE_URL}/job/digitise`, {
      method: "POST",
      headers: { "api-subscription-key": apiKey },
      body: form,
    });
    if (!createRes.ok) return null;
    const job = (await createRes.json()) as DigitiseJobResponse;

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let status = job.status;
    while (status !== "completed" && status !== "partially_completed") {
      if (status === "failed" || status === "rejected" || Date.now() > deadline) return null;
      await sleep(POLL_INTERVAL_MS);
      const statusRes = await fetch(`${BASE_URL}/job/${job.job_id}/status`, {
        headers: { "api-subscription-key": apiKey },
      });
      if (!statusRes.ok) return null;
      status = ((await statusRes.json()) as DigitiseStatusResponse).status;
    }

    const resultsRes = await fetch(`${BASE_URL}/job/${job.job_id}/results`, {
      headers: { "api-subscription-key": apiKey },
    });
    if (!resultsRes.ok) return null;
    const results = (await resultsRes.json()) as DigitiseResultsResponse;

    const text = results.documents
      .flatMap((doc) => doc.pages)
      .flatMap((page) => [...page.blocks].sort((a, b) => a.reading_order - b.reading_order))
      .map((block) => block.text)
      .join("\n")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}
