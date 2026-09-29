/**
 * A small Markdown → blocks parser for document rendering (DOCX, PDF). Models write Markdown
 * fluently, so documents are specified as Markdown and rendered natively — headings, paragraphs,
 * bullet/numbered lists, tables, code blocks, quotes, rules, and inline bold/italic/code/links.
 * Deliberately forgiving: anything it doesn't recognise becomes a plain paragraph, never an error.
 */

export type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; inlines: Inline[] }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "code"; lang: string; text: string }
  | { type: "table"; header: Inline[][]; rows: Inline[][][] }
  | { type: "quote"; inlines: Inline[] }
  | { type: "hr" };

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > last) out.push({ text: text.slice(last, index) });
    if (token.startsWith("**") || token.startsWith("__")) out.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith("`")) out.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith("[")) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      out.push(m ? { text: m[1]!, link: m[2]! } : { text: token });
    } else out.push({ text: token.slice(1, -1), italic: true });
    last = index + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.filter((i) => i.text.length > 0);
}

export function inlineText(inlines: Inline[]): string {
  return inlines.map((i) => i.text).join("");
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "paragraph", inlines: parseInline(para.join(" ").trim()) });
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      i++;
      continue;
    }
    const fence = /^```\s*([\w+-]*)/.exec(trimmed);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) body.push(lines[i++]!);
      i++;
      blocks.push({ type: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: Math.min(4, heading[1]!.length) as 1 | 2 | 3 | 4, inlines: parseInline(heading[2]!.replace(/#+\s*$/, "").trim()) });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush();
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    // Table: a header row followed by a |---|---| separator.
    if (trimmed.includes("|") && i + 1 < lines.length && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(lines[i + 1]!.trim())) {
      flush();
      const header = splitRow(trimmed).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.trim().includes("|")) rows.push(splitRow(lines[i++]!).map(parseInline));
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const t = lines[i]!.trim();
        const m = ordered ? /^\d+[.)]\s+(.*)$/.exec(t) : /^[-*+]\s+(.*)$/.exec(t);
        if (!m) break;
        items.push(parseInline(m[1]!.replace(/^\[[ xX]\]\s+/, "")));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (trimmed.startsWith(">")) {
      flush();
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) body.push(lines[i++]!.trim().replace(/^>\s?/, ""));
      blocks.push({ type: "quote", inlines: parseInline(body.join(" ")) });
      continue;
    }
    para.push(trimmed);
    i++;
  }
  flush();
  return blocks;
}
