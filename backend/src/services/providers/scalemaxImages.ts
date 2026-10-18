import { safeErrorMessage } from "./types.js";
import { safeFetch } from "../agent/safeFetch.js";

// ScaleMax's Images & Video API (docs.scalemax.pro/docs/images/api) — a SEPARATE surface from
// the chat /messages endpoint in scalemax.ts (different base path, different auth style: Bearer
// token here vs x-api-key there). Confirmed live against the real API (2026-09-23):
//   - POST /v1/images/generations -> {"created":..., "data":[{"url": "..."}]}
//   - POST /v1/images/edits with {model, prompt, image: <dataUrl or url>, size, quality, n} ->
//     same {"data":[{"url":...}]} shape. `image` accepts a base64 data URL directly (confirmed:
//     ScaleMax's own error message for a missing image says "a base64-encoded image (or data
//     URL)"), so a user's attachment dataUrl can be sent as-is, no upload/hosting step needed.
const BASE_URL = "https://api.scalemax.pro/token/v1";

// gpt-image-2 (the real OpenAI image model, proxied — its own generation metadata reports
// "Azure OpenAI ImageGen" as the software agent, confirmed live) is the default: verified
// side-by-side against grok-imagine-image with the identical prompt ("a MacBook laptop open on a
// wooden table") — grok returned a completely unrelated lighthouse/coastline photo, gpt-image-2
// nailed it first try. grok-imagine-image is kept available as a fallback option, not the
// default, given that real prompt-adherence gap.
export const DEFAULT_IMAGE_MODEL = "gpt-image-2";

export type ImageQuality = "low" | "medium" | "high";
// Size FORMAT depends on the model family — gpt-image-* wants pixel dimensions
// (1024x1024/1536x864/864x1536, confirmed live), Grok Imagine wants aspect ratios (1:1/16:9/...).
// Kept as a permissive string rather than a strict union so callers can pass whichever shape
// matches their chosen model; DEFAULT_IMAGE_SIZE below matches DEFAULT_IMAGE_MODEL.
export type ImageSize = string;
export const DEFAULT_IMAGE_SIZE: ImageSize = "1024x1024";

interface ImagesResponse {
  data: { url?: string; b64_json?: string }[];
}

// Confirmed live in production (2026-09-23): this fetch had no timeout at all, and a request got
// stuck — no error, no response, the client's "Creating your image" indicator frozen at its
// simulated ceiling forever. The SSE connection itself stays alive throughout (chatController.ts
// sends a `: ping` heartbeat every 15s independent of this), so it wasn't a dropped connection —
// the actual ScaleMax call itself just never resolved. This bounds it so a stuck call fails fast
// and the caller (tryGenerateOrEditImage in chat/index.ts) can fall through to a normal chat
// reply instead of hanging the whole turn indefinitely.
const IMAGE_REQUEST_TIMEOUT_MS = 55_000;

// Seen in production (2026-10-18): every /images/edits call for two days came back as a Cloudflare
// "502 Bad gateway" page from api.scalemax.pro while /images/generations kept working, and the user
// only saw "Couldn't create that image". A 502/503/504 or a timeout from their gateway is usually
// transient, so one retry after a short pause turns most of those into a working edit.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const RETRY_DELAY_MS = 2_000;

class RetryableImageError extends Error {}

async function callImagesEndpoint(path: string, apiKey: string, body: Record<string, unknown>): Promise<string> {
  try {
    return await callImagesEndpointOnce(path, apiKey, body);
  } catch (err) {
    if (!(err instanceof RetryableImageError)) throw err;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return callImagesEndpointOnce(path, apiKey, body);
  }
}

async function callImagesEndpointOnce(path: string, apiKey: string, body: Record<string, unknown>): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new RetryableImageError(`ScaleMax images ${path} timed out after ${IMAGE_REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    // Gateway error pages are whole HTML documents; keep the log line readable.
    const errText = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
    const message = `ScaleMax images ${path} failed: ${res.status} ${errText}`;
    throw RETRYABLE_STATUS.has(res.status) ? new RetryableImageError(message) : new Error(message);
  }
  const json = (await res.json()) as ImagesResponse;
  const first = json.data?.[0];
  if (!first) throw new Error(`ScaleMax images ${path} returned no image data`);
  if (first.url) return first.url;
  if (first.b64_json) return `data:image/png;base64,${first.b64_json}`;
  throw new Error(`ScaleMax images ${path} returned neither url nor b64_json`);
}

export async function generateImage(
  apiKey: string,
  prompt: string,
  options: { model?: string; size?: ImageSize; quality?: ImageQuality } = {},
): Promise<string> {
  return callImagesEndpoint("/images/generations", apiKey, {
    model: options.model ?? DEFAULT_IMAGE_MODEL,
    prompt,
    size: options.size ?? DEFAULT_IMAGE_SIZE,
    quality: options.quality ?? "medium",
    n: 1,
  });
}

/**
 * `source` is either the attachment's own base64 data URL (the normal edit-a-photo-you-attached
 * case, sent as the `image` field) or a previously-generated image's hosted URL (used when
 * continuing/correcting a generation that came back wrong — see imageIntent.ts's
 * findImageCorrection() — sent as `image_url`, both confirmed working live against the real API).
 */
export async function editImage(
  apiKey: string,
  prompt: string,
  source: { dataUrl?: string; url?: string },
  options: { model?: string; size?: ImageSize; quality?: ImageQuality } = {},
): Promise<string> {
  // A hosted source is downloaded here and sent as bytes, so the edit no longer depends on
  // ScaleMax's gateway fetching our storage URL. image_url stays as the fallback if our own
  // download fails.
  const dataUrl = source.dataUrl ?? (source.url ? await toDataUrl(source.url) : null);
  return callImagesEndpoint("/images/edits", apiKey, {
    model: options.model ?? DEFAULT_IMAGE_MODEL,
    prompt,
    ...(dataUrl ? { image: dataUrl } : { image_url: source.url }),
    size: options.size ?? DEFAULT_IMAGE_SIZE,
    quality: options.quality ?? "medium",
    n: 1,
  });
}

const MAX_EDIT_SOURCE_BYTES = 15 * 1024 * 1024;

async function toDataUrl(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url, { maxBytes: MAX_EDIT_SOURCE_BYTES });
    if (res.status !== 200 || res.truncated || !res.body.length) return null;
    const type = res.contentType.split(";")[0]!.trim() || "image/png";
    if (!type.startsWith("image/")) return null;
    return `data:${type};base64,${res.body.toString("base64")}`;
  } catch {
    return null;
  }
}

export function isImageProviderError(err: unknown): string {
  return safeErrorMessage(err);
}
