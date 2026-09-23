import { base64PayloadOf } from "./types.js";

// Source/config/data files that are already plain text — no OCR or office-format parsing needed,
// just decode the attachment's base64 payload as UTF-8. Covers what DOCX/XLSX/PDF/image handling
// (officeDocs.ts, sarvamDocAI.ts) leaves out: code files, XML, CSV, markdown, JSON, plain .txt.
// Previously these mimes weren't matched by ANY extraction path and were filtered out of every
// provider adapter's content blocks too (image/* and application/pdf only) — attached and stored,
// but never actually seen by the model, with no error telling the user why.
const PLAIN_TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/xml",
  "application/xml",
  "application/json",
  "text/x-python",
  "application/x-python-code",
  "text/javascript",
  "application/javascript",
  "text/x-typescript",
  "application/typescript",
  "text/x-java-source",
  "text/x-java",
  "text/x-c",
  "text/x-c++src",
  "text/x-csrc",
  "text/x-go",
  "text/x-rust",
  "text/x-ruby",
  "text/x-php",
  "text/x-swift",
  "text/x-kotlin",
  "text/html",
  "text/css",
  "text/x-yaml",
  "application/x-yaml",
  "text/x-sh",
  "application/sql",
  "text/x-sql",
]);

// Browsers are inconsistent about guessing a mime for source files — confirmed a real gap here,
// not hypothetical: the frontend falls back to "application/octet-stream" whenever `file.type`
// comes back empty (src/lib/chat/files.ts), which .py/.rs/.yml etc. do on some OS/browser
// combinations. A generic/unhelpful mime is recovered from the filename extension instead of
// silently failing to match.
const CODE_EXTENSIONS = new Set([
  "txt", "md", "csv", "json", "xml", "py", "js", "ts", "jsx", "tsx", "java", "c", "cpp", "cc",
  "h", "hpp", "go", "rs", "rb", "php", "swift", "kt", "html", "htm", "css", "yaml", "yml", "sh",
  "bash", "sql", "log", "ini", "toml", "env", "gitignore", "dockerfile",
]);
const GENERIC_MIMES = new Set(["application/octet-stream", ""]);

function extensionOf(name?: string): string | null {
  if (!name) return null;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? null : name.slice(dot + 1).toLowerCase();
}

// A generic "text/*" mime not in the explicit list above (e.g. a browser guessing "text/x-log"
// for a .log file) is still plain text by definition — accept the whole prefix, not just the
// enumerated set, so this doesn't need a new entry for every possible source-file extension.
export function isPlainTextDocument(mime: string, name?: string): boolean {
  if (PLAIN_TEXT_MIMES.has(mime) || mime.startsWith("text/")) return true;
  if (GENERIC_MIMES.has(mime)) {
    const ext = extensionOf(name);
    return ext !== null && CODE_EXTENSIONS.has(ext);
  }
  return false;
}

const MAX_TEXT_CHARS = 50_000;

/** Decodes a plain-text/code attachment's base64 payload directly — synchronous, no external API. */
export function extractPlainText(dataUrl: string, mime: string, name?: string): string | null {
  if (!isPlainTextDocument(mime, name)) return null;
  try {
    const buffer = Buffer.from(base64PayloadOf(dataUrl), "base64");
    const text = buffer.toString("utf-8").trim();
    if (!text) return null;
    return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n…(truncated)` : text;
  } catch {
    return null;
  }
}
