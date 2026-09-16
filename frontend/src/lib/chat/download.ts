const EXT: Record<string, string> = {
  html: "html",
  css: "css",
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  jsx: "jsx",
  python: "py",
  py: "py",
  json: "json",
  markdown: "md",
  md: "md",
  svg: "svg",
  txt: "txt",
  sh: "sh",
  bash: "sh",
  xml: "xml",
  yaml: "yml",
  yml: "yml",
  sql: "sql",
  rust: "rs",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
};

export function extForLang(lang?: string) {
  if (!lang) return "txt";
  return EXT[lang.toLowerCase()] ?? "txt";
}

export function sanitizeFilename(name: string) {
  const cleaned = name
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "friday-file";
}

export function filenameForLang(lang?: string, stem = "snippet") {
  return `${stem}.${extForLang(lang)}`;
}

function mimeForName(filename: string, fallback = "application/octet-stream") {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "html") return "text/html;charset=utf-8";
  if (ext === "md") return "text/markdown;charset=utf-8";
  if (ext === "json") return "application/json;charset=utf-8";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "css") return "text/css;charset=utf-8";
  return fallback;
}

function clickBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// A data: URL (e.g. an attached image's dataUrl) has to be decoded through fetch() into real
// binary — wrapping the string itself in `new Blob([dataUrl])` would save a text file containing
// the literal "data:image/png;base64,...." rather than the actual image.
async function toBlob(data: string | Blob, type: string): Promise<Blob> {
  if (data instanceof Blob) return data;
  if (data.startsWith("data:")) return (await fetch(data)).blob();
  return new Blob([data], { type });
}

/**
 * Previously POSTed through a hidden iframe to a backend `/api/download` route that was never
 * actually implemented — the request 404'd silently inside the hidden iframe (no JS exception,
 * so the function returned `true` and looked like it worked), and nothing ever downloaded.
 * Confirmed live: the download button in Canvas and the chat message actions did nothing. Fixed
 * by dropping that dead round-trip entirely and saving directly via a Blob + `<a download>`,
 * which needs no backend at all.
 */
export async function saveFile(
  filename: string,
  data: string | Blob,
  mime?: string,
): Promise<boolean> {
  const name = sanitizeFilename(filename);
  const type = mime || mimeForName(name);
  try {
    const blob = await toBlob(data, type);
    clickBlob(name, blob);
    return true;
  } catch {
    if (typeof data === "string" && !data.startsWith("data:")) {
      try {
        await navigator.clipboard.writeText(data);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}
