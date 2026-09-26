export type Artifact = {
  kind: "html" | "code" | "react" | "runnable";
  body: string;
  lang?: string;
  title: string;
  /** Separate ```css fence(s) from the same reply — a React component or page is usually
   *  written as `App.jsx` + `App.css`, so the preview needs the stylesheet too. */
  css?: string;
};

/** Injects an extra stylesheet into a full HTML document for the preview. */
export function withExtraCss(html: string, css?: string): string {
  if (!css) return html;
  const tag = `<style>${css}</style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : `${tag}${html}`;
}

const FENCE = /```(\w+)?\n([\s\S]*?)```/g;
// Languages Canvas can actually execute for real (in an isolated E2B VM), vs. just
// display as static text — see runnable.ts and the sandbox controller/service on the backend,
// and RunCodeLanguage in the E2B SDK for the full set it supports.
const RUNNABLE_LANGS = new Set([
  "python",
  "py",
  "javascript",
  "js",
  "typescript",
  "ts",
  "r",
  "java",
  "bash",
  "sh",
  "shell",
]);

// Some models (this got noticeably worse after a model switch) write a React component and
// still fence it as ```javascript/```js instead of ```jsx — RUNNABLE_LANGS would then send a
// browser-only React component into the sandbox's plain Node/Python executor, where it can't
// possibly run (no DOM, no React). Anything that's clearly React (JSX markup, or the hooks API)
// gets treated as a react-preview artifact instead, regardless of which of those two tags it used.
function looksLikeReactComponent(body: string): boolean {
  const hasJsxTag = /<([A-Za-z][\w.]*)[^>]*>[\s\S]*<\/\1>/.test(body) || /<[A-Za-z][\w.]*[^>]*\/>/.test(body);
  const hasReactApi = /\b(useState|useEffect|useRef|useMemo|useCallback|useContext|useReducer)\s*\(/.test(body);
  return hasJsxTag || hasReactApi;
}

const CHAT_ONLY_LANGS = new Set(["mermaid", "text", "plaintext", "txt", "markdown", "md"]);

export function extractArtifact(content: string): Artifact | null {
  const text = content.trim();
  if (!text) return null;
  const blocks = [...text.matchAll(FENCE)];
  const html = blocks.find((b) => (b[1] ?? "").toLowerCase() === "html");
  const css = blocks
    .filter((b) => (b[1] ?? "").toLowerCase() === "css")
    .map((b) => (b[2] ?? "").trim())
    .filter(Boolean)
    .join("\n\n") || undefined;
  if (html?.[2]?.trim()) {
    return { kind: "html", body: html[2].trim(), title: "Canvas", lang: "html", css };
  }
  const react = blocks.find((b) => {
    const lang = (b[1] ?? "").toLowerCase();
    if (["tsx", "jsx"].includes(lang)) return true;
    return ["javascript", "js", "typescript", "ts"].includes(lang) && looksLikeReactComponent(b[2] ?? "");
  });
  if (react?.[2]?.trim()) {
    return { kind: "react", body: react[2].trim(), lang: react[1] || "jsx", title: `${react[1] || "jsx"} canvas`, css };
  }
  const runnable = blocks.find((b) => RUNNABLE_LANGS.has((b[1] ?? "").toLowerCase()));
  if (runnable?.[2]?.trim()) {
    return { kind: "runnable", body: runnable[2].trim(), lang: runnable[1], title: `${runnable[1]} canvas` };
  }
  // CSS has nothing to execute — it only ever makes sense rendered inside an HTML/React
  // artifact, never as its own runnable/preview kind — so it's the one language left here.
  const code = blocks.find((b) => (b[1] ?? "").toLowerCase() === "css");
  if (code?.[2]?.trim()) {
    return {
      kind: "code",
      body: code[2].trim(),
      lang: code[1],
      title: code[1] ? `${code[1]} canvas` : "Canvas",
    };
  }
  // Diagrams and copy-paste text (emails, prompts, templates) belong in the chat bubble — they have
  // their own diagram / copy-box rendering there — so they never become a Canvas artifact.
  const first = blocks.find((b) => !CHAT_ONLY_LANGS.has((b[1] ?? "").toLowerCase()));
  if (first?.[2]?.trim() && text.length > 120) {
    return {
      kind: "code",
      body: first[2].trim(),
      lang: first[1],
      title: "Canvas",
    };
  }
  // A reply with no fenced code at all is a conversational answer, not a build artifact — it
  // belongs in the chat bubble only. Canvas used to fall back to showing this same prose as
  // "markdown", which just duplicated the chat answer verbatim in both panes.
  return null;
}

/**
 * Whatever's been typed into an OPEN (not yet closed) fenced code block, for the live "writing
 * code" view in Canvas while a reply is still streaming — extractArtifact() only returns once the
 * closing ``` has actually arrived, so without this Canvas had nothing to show but a bare spinner
 * for the entire time the code was being generated.
 */
export function extractStreamingCodeBody(content: string): { lang?: string; body: string } | null {
  const openFence = /```(\w+)?\n([\s\S]*)$/.exec(content);
  if (!openFence) return null;
  return { lang: openFence[1], body: openFence[2] ?? "" };
}

// Languages extractArtifact treats as a build artifact with no length gate at all — the ones
// that can legitimately still be an OPEN, not-yet-closed fence while streaming and already be
// certain to end up in Canvas: html/react, every RUNNABLE_LANGS entry, and css (the one
// remaining static "code" kind). Deliberately excludes the generic "first block, any language"
// fallback (gated on text.length > 120), which can't be predicted before it closes.
const VISUAL_FENCE_LANGS = /^(?:html|jsx|tsx|python|py|javascript|js|typescript|ts|r|java|bash|sh|shell|css)$/i;

/**
 * Cuts whatever fenced code block extractArtifact() picked as the Canvas artifact out of a
 * message's text before it's shown in the chat bubble, so the same code never appears twice —
 * once flooding the chat as a giant raw block, once properly rendered in Canvas. Driven by
 * extractArtifact itself (rather than a separate hardcoded language list) so every kind it can
 * return — html/react/runnable, the preferred typescript/css block, and the generic first-block
 * fallback — is covered here without the two functions being able to drift out of sync.
 * Also handles the still-streaming case (an opened but not yet closed fence) for the languages
 * that are guaranteed to become an artifact regardless of length. A no-op for a plain
 * conversational reply with no code fence at all.
 */
export function stripVisualArtifactForChat(content: string): string {
  const artifact = extractArtifact(content);
  if (artifact) {
    const blocks = [...content.matchAll(FENCE)];
    const match = blocks.find((b) => b[2]?.trim() === artifact.body);
    if (match) {
      const start = match.index!;
      return (content.slice(0, start) + content.slice(start + match[0].length)).trim();
    }
  }
  const open = /```(\w+)?\b/.exec(content);
  if (open && VISUAL_FENCE_LANGS.test(open[1] ?? "")) return content.slice(0, open.index).trim();
  return content;
}
