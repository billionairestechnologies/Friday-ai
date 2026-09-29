import type { SearchReplace } from "./protocol.js";

/**
 * Builds the rich, size-capped activity payloads for Build Mode step rows (see BuildStep in
 * chat/types.ts): code cards for file writes/edits and a live terminal for commands. Everything here
 * is capped because steps are both streamed to the client and persisted on the message — a 60-round
 * build must not turn one chat message into megabytes of JSON.
 */

export const CODE_PREVIEW_CHARS = 1_800;
export const CODE_PREVIEW_LINES = 40;
export const LIVE_OUTPUT_CHARS = 4_000;
export const SAVED_OUTPUT_CHARS = 1_500;

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", html: "html", htm: "html", css: "css", scss: "scss", md: "markdown", py: "python",
  sh: "bash", yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", go: "go", rs: "rust", java: "java",
  kt: "kotlin", swift: "swift", rb: "ruby", php: "php", vue: "html", svelte: "html", env: "bash",
};

export function langForPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  if (name === "Dockerfile") return "dockerfile";
  if (name.startsWith(".env")) return "bash";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return LANG_BY_EXT[ext] ?? "text";
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** The first lines of a freshly written file, for the code card. */
export function codePreview(content: string): { code: string; added: number } {
  const lines = content.split("\n");
  let code = lines.slice(0, CODE_PREVIEW_LINES).join("\n");
  if (code.length > CODE_PREVIEW_CHARS) code = code.slice(0, CODE_PREVIEW_CHARS);
  if (code.length < content.length) code += `\n… ${Math.max(0, lines.length - CODE_PREVIEW_LINES)} more lines`;
  return { code, added: countLines(content) };
}

/** A compact -/+ diff of SEARCH/REPLACE edits (what an edit_file changed), for the code card. */
export function editDiff(edits: SearchReplace[]): { code: string; added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const parts: string[] = [];
  for (const edit of edits) {
    const before = edit.search ? edit.search.split("\n") : [];
    const after = edit.replace ? edit.replace.split("\n") : [];
    // Drop the shared leading/trailing context lines so the diff shows only what changed.
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    const minus = before.slice(head, before.length - tail);
    const plus = after.slice(head, after.length - tail);
    removed += minus.length;
    added += plus.length;
    parts.push([...minus.map((l) => `- ${l}`), ...plus.map((l) => `+ ${l}`)].join("\n"));
  }
  let code = parts.filter(Boolean).join("\n⋯\n");
  if (code.length > CODE_PREVIEW_CHARS) code = `${code.slice(0, CODE_PREVIEW_CHARS)}\n…`;
  return { code, added, removed };
}

/** Keeps the end of a growing log (the newest output is what matters in a terminal). */
export function tailText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const nl = cut.indexOf("\n");
  return `…${nl >= 0 && nl < 200 ? cut.slice(nl) : cut}`;
}

/**
 * Collects streamed command output and calls `emit` at most every `intervalMs`, so a chatty
 * `npm install` produces a few UI updates per second, not thousands of SSE events.
 */
export function throttledOutput(emit: (output: string) => void, intervalMs = 250) {
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSent = "";
  const flush = () => {
    timer = null;
    const out = tailText(buffer, LIVE_OUTPUT_CHARS);
    if (out !== lastSent) {
      lastSent = out;
      emit(out);
    }
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      // Bound memory for commands that print megabytes.
      if (buffer.length > LIVE_OUTPUT_CHARS * 4) buffer = buffer.slice(buffer.length - LIVE_OUTPUT_CHARS * 2);
      if (!timer) timer = setTimeout(flush, intervalMs);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
