import { safeErrorMessage } from "./types.js";

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

async function callImagesEndpoint(path: string, apiKey: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ScaleMax images ${path} failed: ${res.status} ${errText}`);
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
  return callImagesEndpoint("/images/edits", apiKey, {
    model: options.model ?? DEFAULT_IMAGE_MODEL,
    prompt,
    ...(source.dataUrl ? { image: source.dataUrl } : { image_url: source.url }),
    size: options.size ?? DEFAULT_IMAGE_SIZE,
    quality: options.quality ?? "medium",
    n: 1,
  });
}

export function isImageProviderError(err: unknown): string {
  return safeErrorMessage(err);
}
