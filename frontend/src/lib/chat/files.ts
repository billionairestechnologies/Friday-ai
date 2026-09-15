import type { Attachment } from "./types";
import { uid } from "../utils";

const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/jpg",
]);

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

export async function fileToAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_BYTES) {
    throw new Error(`${file.name} is larger than 10 MB`);
  }
  const dataUrl = await readAsDataUrl(file);
  const isImage = IMAGE_TYPES.has(file.type) || file.type.startsWith("image/");
  return {
    id: uid(),
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    kind: isImage ? "image" : "file",
    dataUrl,
  };
}
