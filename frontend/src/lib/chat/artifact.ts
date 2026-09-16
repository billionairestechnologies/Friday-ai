export type Artifact = {
  kind: "html" | "markdown" | "code" | "react";
  body: string;
  lang?: string;
  title: string;
};

const FENCE = /```(\w+)?\n([\s\S]*?)```/g;

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
  const preferred = ["javascript", "typescript", "css", "python"];
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
