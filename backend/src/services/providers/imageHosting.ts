import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../../config/supabase.js";
import { safeFetch } from "../agent/safeFetch.js";
import { logger } from "../../utils/logger.js";

/**
 * ScaleMax's /images/generations and /images/edits hand back a URL on ITS OWN infrastructure, not
 * image bytes. That URL isn't guaranteed to stay valid — once it expires, a reopened chat shows a
 * broken <img> (the message markdown still points at the dead vendor URL) and "edit that image"
 * fails outright (editImage sends the same dead URL to ScaleMax as image_url, which can't fetch
 * it). Re-hosting the bytes on our own storage right after generation, before the markdown that
 * gets saved to messages.content and replayed into history is built, makes the URL durable.
 * Public bucket (not DOCUMENTS_BUCKET's private one) because the markdown renders straight into an
 * <img src> with no auth header — same tradeoff a direct CDN link would have, and the random UUID
 * path keeps it unguessable.
 */
const IMAGES_BUCKET = "generated-images";
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { error } = await supabaseAdmin.storage.createBucket(IMAGES_BUCKET, { public: true, fileSizeLimit: MAX_IMAGE_BYTES });
  if (error && !/exist/i.test(error.message)) throw new Error(error.message);
  bucketReady = true;
}

async function fetchImageBytes(source: string): Promise<{ bytes: Buffer; contentType: string }> {
  const dataUrlMatch = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(source);
  if (dataUrlMatch) {
    const [, contentType, isBase64, payload] = dataUrlMatch;
    const bytes = isBase64 ? Buffer.from(payload!, "base64") : Buffer.from(decodeURIComponent(payload!), "utf8");
    return { bytes, contentType: contentType || "image/png" };
  }
  const res = await safeFetch(source, { maxBytes: MAX_IMAGE_BYTES });
  return { bytes: res.body, contentType: res.contentType || "image/png" };
}

/**
 * Downloads a freshly generated image (vendor URL or data: URL) and re-uploads it to our own
 * storage, returning a durable public URL. Best-effort: on any failure, returns the original
 * source so the current turn still shows the image — only the next reload/edit would be affected,
 * same as before this existed, rather than failing the whole turn over a storage hiccup.
 */
export async function rehostGeneratedImage(userId: string, source: string): Promise<string> {
  try {
    await ensureBucket();
    const { bytes, contentType } = await fetchImageBytes(source);
    const ext = EXT_BY_CONTENT_TYPE[contentType] ?? "png";
    const path = `${userId}/${randomUUID()}.${ext}`;
    const { error } = await supabaseAdmin.storage.from(IMAGES_BUCKET).upload(path, bytes, { contentType, upsert: false });
    if (error) throw new Error(error.message);
    const { data } = supabaseAdmin.storage.from(IMAGES_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    logger.warn("[imageHosting] failed to re-host generated image, keeping vendor URL", {
      error: err instanceof Error ? err.message : String(err),
    });
    return source;
  }
}
