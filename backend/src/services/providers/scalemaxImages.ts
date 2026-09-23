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

// grok-imagine-image is the model this integration was verified end-to-end against (both
// generate and edit, live). Other catalog models (gpt-image-*, flux-2-*) likely work identically
// since they're the same endpoint/shape, but haven't been confirmed — keep this the default
// until one of those is verified too.
export const DEFAULT_IMAGE_MODEL = "grok-imagine-image";

export type ImageQuality = "low" | "medium" | "high";
// Grok Imagine's size values are aspect ratios, not pixel dimensions.
export type ImageSize = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3" | "auto";

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
    size: options.size ?? "1:1",
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
    size: options.size ?? "1:1",
    quality: options.quality ?? "medium",
    n: 1,
  });
}

export function isImageProviderError(err: unknown): string {
  return safeErrorMessage(err);
}
