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

const FRAME = "friday-download-frame";

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

function ensureFrame() {
  let frame = document.querySelector(`iframe[name="${FRAME}"]`) as HTMLIFrameElement | null;
  if (!frame) {
    frame = document.createElement("iframe");
    frame.name = FRAME;
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    Object.assign(frame.style, {
      position: "fixed",
      width: "0",
      height: "0",
      border: "0",
      opacity: "0",
      pointerEvents: "none",
    });
    document.body.appendChild(frame);
  }
  return frame;
}

function postThroughIframe(filename: string, content: string, mime: string) {
  ensureFrame();
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/download";
  form.target = FRAME;
  form.acceptCharset = "UTF-8";
  const fields: Record<string, string> = { filename, mime, content };
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
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

async function asText(data: string | Blob): Promise<string> {
  if (typeof data === "string") return data;
  if (data.type.startsWith("text/") || data.type.includes("json") || data.type.includes("svg")) {
    return await data.text();
  }
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(data);
  });
}

export async function saveFile(
  filename: string,
  data: string | Blob,
  mime?: string,
): Promise<boolean> {
  const name = sanitizeFilename(filename);
  const type = mime || mimeForName(name);
  try {
    const text = await asText(data);
    postThroughIframe(name, text, type);
    return true;
  } catch {
    try {
      const blob =
        data instanceof Blob ? data : new Blob([data], { type });
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
}
