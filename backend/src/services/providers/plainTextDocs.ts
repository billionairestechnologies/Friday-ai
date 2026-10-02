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
  "txt", "md", "markdown", "mdx", "rst", "csv", "tsv", "json", "jsonl", "ndjson", "xml", "xaml", "xsd", "xsl", "xslt",
  "svg", "plist", "resx", "csproj", "vbproj", "fsproj", "sln", "props", "targets", "nuspec", "config", "manifest",
  "py", "pyi", "ipynb", "js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx", "vue", "svelte", "astro", "java", "kt",
  "kts", "scala", "groovy", "gradle", "c", "cpp", "cc", "cxx", "h", "hpp", "hh", "m", "mm", "cs", "vb", "fs", "fsx",
  "go", "rs", "rb", "php", "swift", "dart", "lua", "pl", "pm", "r", "jl", "ex", "exs", "erl", "hs", "clj", "elm", "zig",
  "nim", "sol", "html", "htm", "xhtml", "css", "scss", "sass", "less", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "properties", "env", "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "sql", "graphql", "gql", "proto",
  "prisma", "tf", "hcl", "log", "tex", "bib", "srt", "vtt", "rtf", "gitignore", "dockerignore", "editorconfig",
  "dockerfile", "makefile", "cmake", "lock",
]);
const MAX_TEXT_CHARS = 50_000;
const GENERIC_MIMES = new Set(["application/octet-stream", ""]);

function extensionOf(name?: string): string | null {
  if (!name) return null;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? null : name.slice(dot + 1).toLowerCase();
}

// A generic "text/*" mime not in the explicit list above (e.g. a browser guessing "text/x-log"
// for a .log file) is still plain text by definition — accept the whole prefix, not just the
// enumerated set, so this doesn't need a new entry for every possible source-file extension.
/** True when the file name alone says it's text/code (used for archive entries, which have no mime). */
export function isTextFileName(name: string): boolean {
  const base = name.split("/").pop()!.toLowerCase();
  if (base === "dockerfile" || base === "makefile" || base === "readme" || base === "license") return true;
  const ext = extensionOf(base);
  return ext !== null && CODE_EXTENSIONS.has(ext);
}

/** UTF-8 decode, refusing binary content (NUL bytes in the first 8 KB) so a mis-named binary isn't fed to a model as garbage. */
export function decodeTextBuffer(buffer: Buffer, maxChars = MAX_TEXT_CHARS): string | null {
  if (buffer.subarray(0, 8192).includes(0)) return null;
  const text = buffer.toString("utf-8").trim();
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
}

// Production incident (2026-10-02): a "Friday email lead.csv" arrived as application/vnd.ms-excel (what Chrome
// reports for .csv on machines with Excel installed) — not text/*, not generic — so it was matched by NO
// extraction path, the model never saw it and answered "please upload the file". These extensions are text
// whatever mime the browser guessed, as long as the mime isn't a real binary type we handle elsewhere.
const TEXT_WHATEVER_THE_MIME = new Set(["csv", "tsv", "txt", "md", "json", "jsonl", "xml", "log", "yml", "yaml"]);
const BINARY_MIME = /^(image\/|audio\/|video\/|application\/pdf$|application\/zip$|application\/vnd\.openxmlformats|application\/vnd\.oasis)/;

export function isPlainTextDocument(mime: string, name?: string): boolean {
  if (PLAIN_TEXT_MIMES.has(mime) || mime.startsWith("text/")) return true;
  const ext = extensionOf(name);
  if (GENERIC_MIMES.has(mime)) return ext !== null && CODE_EXTENSIONS.has(ext);
  return ext !== null && TEXT_WHATEVER_THE_MIME.has(ext) && !BINARY_MIME.test(mime);
}


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
