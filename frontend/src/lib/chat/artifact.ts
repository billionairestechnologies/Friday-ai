export type Artifact = {
  kind: "html" | "markdown" | "code" | "react" | "runnable";
  body: string;
  lang?: string;
  title: string;
};

const FENCE = /```(\w+)?\n([\s\S]*?)```/g;
// Languages Canvas can actually execute for real (in an isolated E2B VM), vs. just
// display as static text — see runnable.ts and the sandbox controller/service on the backend.
const RUNNABLE_LANGS = new Set(["python", "py", "javascript", "js"]);

export function extractArtifact(content: string): Artifact | null {
  const text = content.trim();
  if (!text) return null;
  const blocks = [...text.matchAll(FENCE)];
  const html = blocks.find((b) => (b[1] ?? "").toLowerCase() === "html");
  if (html?.[2]?.trim()) {
    return { kind: "html", body: html[2].trim(), title: "Canvas", lang: "html" };
  }
  const react = blocks.find((b) => ["tsx", "jsx"].includes((b[1] ?? "").toLowerCase()));
  if (react?.[2]?.trim()) {
    return { kind: "react", body: react[2].trim(), lang: react[1], title: `${react[1]} canvas` };
  }
  const runnable = blocks.find((b) => RUNNABLE_LANGS.has((b[1] ?? "").toLowerCase()));
  if (runnable?.[2]?.trim()) {
    return { kind: "runnable", body: runnable[2].trim(), lang: runnable[1], title: `${runnable[1]} canvas` };
  }
  const preferred = ["typescript", "css"];
  const code = blocks.find((b) => preferred.includes((b[1] ?? "").toLowerCase()));
  if (code?.[2]?.trim()) {
    return {
      kind: "code",
      body: code[2].trim(),
      lang: code[1],
      title: code[1] ? `${code[1]} canvas` : "Canvas",
    };
  }
  if (blocks[0]?.[2]?.trim() && text.length > 120) {
    return {
      kind: "code",
      body: blocks[0][2].trim(),
      lang: blocks[0][1],
      title: "Canvas",
    };
  }
  if (text.length > 40) {
    return { kind: "markdown", body: text, title: "Canvas" };
  }
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

const VISUAL_FENCE_LANGS = /^(?:html|jsx|tsx|python|py|javascript|js)$/i;

/**
 * Cuts an auto-canvas fenced code block (html/jsx/tsx, plus the runnable langs python/js — see
 * RUNNABLE_LANGS above, everything maybeAutoOpenCanvas in routes/index.tsx opens Canvas for) out
 * of a message's text before it's shown in the chat bubble, so the same code doesn't appear
 * twice — once flooding the chat as a giant raw block, once properly rendered in Canvas.
 * Handles the still-streaming case too (an opened but not yet closed fence), not just a completed
 * one, so the code never appears in chat even momentarily while it's being generated. A no-op for
 * any message that doesn't contain one of these fences.
 */
export function stripVisualArtifactForChat(content: string): string {
  const closed = /```(html|jsx|tsx|python|py|javascript|js)\n[\s\S]*?```/i.exec(content);
  if (closed && VISUAL_FENCE_LANGS.test(closed[1] ?? "")) {
    const start = closed.index;
    return (content.slice(0, start) + content.slice(start + closed[0].length)).trim();
  }
  const open = /```(html|jsx|tsx|python|py|javascript|js)\b/i.exec(content);
  if (open) return content.slice(0, open.index).trim();
  return content;
}
