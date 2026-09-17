import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import type { ChatImage } from "./providers/types.js";
import { logger } from "../utils/logger.js";

export const ATTACHMENT_BUCKET = "message-attachments";

function extensionForMime(mime: string, name?: string): string {
  if (name && name.includes(".")) {
    const ext = name.split(".").pop()?.toLowerCase();
    if (ext && /^[a-z0-9]{1,8}$/.test(ext)) return ext;
  }
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("wordprocessingml")) return "docx";
  if (mime.includes("spreadsheetml")) return "xlsx";
  return "bin";
}

function decodeDataUrl(dataUrl: string): { bytes: Buffer; mime: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  try {
    return { mime: match[1], bytes: Buffer.from(match[2], "base64") };
  } catch {
    return null;
  }
}

export type StoredAttachmentRow = {
  name: string;
  mime: string;
  size_bytes: number;
  kind: "image" | "file";
  data_url: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
};

export async function storeAttachments(
  userId: string,
  messageId: string,
  attachments: ChatImage[],
): Promise<StoredAttachmentRow[]> {
  const rows: StoredAttachmentRow[] = [];

  for (const [index, attachment] of attachments.entries()) {
    const kind = attachment.kind ?? (attachment.mime.startsWith("image/") ? "image" : "file");
    const name = attachment.name || `attachment-${index + 1}`;
    const base: StoredAttachmentRow = {
      name,
      mime: attachment.mime,
      size_bytes: attachment.size ?? 0,
      kind,
      data_url: attachment.dataUrl,
      storage_bucket: null,
      storage_path: null,
    };

    if (!env.attachmentObjectStorageEnabled) {
      rows.push(base);
      continue;
    }

    const decoded = decodeDataUrl(attachment.dataUrl);
    if (!decoded) {
      rows.push(base);
      continue;
    }

    const path = `${userId}/${messageId}/${randomUUID()}.${extensionForMime(attachment.mime, name)}`;
    const { error } = await supabaseAdmin.storage.from(ATTACHMENT_BUCKET).upload(path, decoded.bytes, {
      contentType: attachment.mime,
      upsert: false,
    });

    if (error) {
      logger.warn("attachment_upload_failed", { messageId, error: error.message });
      rows.push(base);
      continue;
    }

    rows.push({
      ...base,
      // Prefer object storage for reload; keep inline only when storage is unavailable.
      data_url: null,
      storage_bucket: ATTACHMENT_BUCKET,
      storage_path: path,
      size_bytes: attachment.size ?? decoded.bytes.byteLength,
    });
  }

  return rows;
}

export async function resolveAttachmentDataUrl(row: {
  data_url: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  mime: string;
}): Promise<string> {
  if (row.data_url) return row.data_url;
  if (!row.storage_bucket || !row.storage_path) return "";

  const { data, error } = await supabaseAdmin.storage
    .from(row.storage_bucket)
    .createSignedUrl(row.storage_path, 60 * 60);

  if (error || !data?.signedUrl) {
    logger.warn("attachment_signed_url_failed", {
      path: row.storage_path,
      error: error?.message,
    });
    return "";
  }
  return data.signedUrl;
}
