import { base64PayloadOf } from "./types.js";

const BASE_URL = "https://api.sarvam.ai/doc-ai/v1";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000;

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
 * Runs a PDF through Sarvam's Doc AI digitise pipeline (real OCR/layout extraction, verified
 * live against the actual API — not the same thing as the gated Gemma4 vision beta on Sarvam's
 * main chat endpoint) and returns its text content in reading order. This is what makes a PDF
 * usable by ANY chat model, not just ones with native document support (Anthropic/Gemini): the
 * PDF never has to reach the LLM as a file at all, only as plain extracted text folded into the
 * message — see appendExtractedText() in promptContext.ts.
 *
 * Returns null (never throws) on any failure — extraction is a best-effort enhancement, and a
 * PDF that fails to digitise should fall back to whatever native support the chosen model has,
 * not blow up the whole request.
 */
export async function digitisePdf(apiKey: string, dataUrl: string, filename: string): Promise<string | null> {
  try {
    const bytes = Buffer.from(base64PayloadOf(dataUrl), "base64");
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/pdf" }), filename);
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
