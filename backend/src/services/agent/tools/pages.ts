import type { SheetSpec, SlideSpec } from "../../documents/render.js";
import { applyEdits, type EditArgs } from "../../pages/pageEdits.js";
import { createPage, getPage, updatePage, type DocContent, type Page, type PageKind, type SheetContent, type SlidesContent } from "../../pages/pageService.js";
import { str, type FridayTool } from "./types.js";

/**
 * Live pages for the agent: create_page makes a doc / sheet / slide deck the user can edit in place
 * and share (vs create_document, a one-off file); read_page and update_page let Friday revise one
 * later — including after the user edited it — without clobbering their edits (versioned saves).
 */

const stringList = { type: "array", items: { type: "string" } };
const KINDS: PageKind[] = ["doc", "sheet", "slides"];

/** A1-style "B3" → [row index in rows (0 = first data row), column index]. Row 1 is the header. */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]{1,3})(\d{1,6})$/i.exec(ref.trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 2, col: col - 1 };
}

function pageCard(page: Page) {
  const summary = page.kind === "doc" ? "Document" : page.kind === "sheet" ? "Spreadsheet" : "Slides";
  return { id: page.id, title: page.title, filename: page.title, format: "page" as const, pageKind: page.kind, size: 0, summary, createdAt: page.created_at };
}

function describe(page: Page): string {
  if (page.kind === "doc") return (page.content as DocContent).markdown;
  if (page.kind === "sheet") {
    return (page.content as SheetContent).sheets
      .map((s) => `== Sheet: ${s.name} ==\n${[s.columns ?? [], ...(s.rows ?? [])].map((r, i) => `${i + 1}: ${(r as unknown[]).join(" | ")}`).join("\n")}`)
      .join("\n\n");
  }
  return JSON.stringify((page.content as SlidesContent).slides, null, 1);
}

const contentProps = {
  markdown: { type: "string", description: "doc: the whole document as Markdown (headings, lists, tables, quotes)" },
  sheets: {
    type: "array",
    description: "sheet: tabs with columns + rows (cells as strings; start with = for a formula, e.g. =SUM(B2:B9))",
    items: { type: "object", properties: { name: { type: "string" }, columns: stringList, rows: { type: "array", items: stringList } } },
  },
  slides: {
    type: "array",
    description: "slides: layouts title, section, bullets, two_column, stats, quote, table, chart — same fields as create_document",
    items: {
      type: "object",
      properties: {
        layout: { type: "string", enum: ["title", "section", "bullets", "two_column", "stats", "quote", "table", "chart"] },
        title: { type: "string" },
        subtitle: { type: "string" },
        bullets: stringList,
        left_title: { type: "string" },
        left: stringList,
        right_title: { type: "string" },
        right: stringList,
        quote: { type: "string" },
        table: { type: "array", items: stringList },
        notes: { type: "string" },
      },
    },
  },
};

export const createPageTool: FridayTool = {
  spec: {
    name: "create_page",
    description:
      "Create a live Friday page the user can open, edit in place, share by link and export: a doc (report, plan, memo, " +
      "notes, article, proposal), a sheet (budget, tracker, table, model with formulas) or slides (a deck). Prefer this " +
      "over create_document whenever the user will keep working on it; use create_document only when they ask for a " +
      "specific file format (.docx, .xlsx, .pptx, .pdf…). Write complete, real content — no placeholders. The page appears " +
      "as a card under your reply; afterwards just say what it contains in a sentence.",
    parameters: {
      type: "object",
      properties: { kind: { type: "string", enum: KINDS }, title: { type: "string" }, ...contentProps, theme_color: { type: "string", description: "slides: accent hex" } },
      required: ["kind", "title"],
    },
  },
  label: (args) => `Creating ${str(args, "kind") === "sheet" ? "a sheet" : str(args, "kind") === "slides" ? "slides" : "a doc"} · ${str(args, "title").slice(0, 60)}`,
  async run(args, ctx) {
    const kind = str(args, "kind") as PageKind;
    if (!KINDS.includes(kind)) throw new Error("kind must be doc, sheet or slides");
    const content =
      kind === "doc" ? { markdown: typeof args.markdown === "string" ? args.markdown : "" } : kind === "sheet" ? { sheets: args.sheets as SheetSpec[] } : { slides: args.slides as SlideSpec[], theme_color: str(args, "theme_color") || undefined };
    if (kind === "doc" && !(content as DocContent).markdown.trim()) throw new Error("A doc needs `markdown`.");
    if (kind === "sheet" && !Array.isArray(args.sheets)) throw new Error("A sheet needs `sheets`.");
    if (kind === "slides" && !Array.isArray(args.slides)) throw new Error("Slides need `slides`.");
    const page = await createPage(ctx.userId, { kind, title: str(args, "title") || "Untitled", content, conversationId: ctx.conversationId, author: "friday" });
    ctx.onFile?.(pageCard(page));
    return `Created ${kind} "${page.title}" (page id ${page.id}, version ${page.version}). The user sees a card to open it.`;
  },
};

export const readPageTool: FridayTool = {
  spec: {
    name: "read_page",
    description: "Read a Friday page's current content and version (the user may have edited it since you wrote it). Do this before update_page.",
    parameters: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
  },
  label: () => "Read the page",
  async run(args, ctx) {
    const page = await getPage(ctx.userId, str(args, "page_id"));
    const body = describe(page);
    return `${page.kind} "${page.title}" — version ${page.version}\n\n${body.length > 60_000 ? `${body.slice(0, 60_000)}\n…(truncated)` : body}`;
  },
};

export const updatePageTool: FridayTool = {
  spec: {
    name: "update_page",
    description:
      "Change a Friday page. Pass `version` from your latest read_page (a newer save by the user is never overwritten — read " +
      "again and redo the change). Make the SMALLEST change that does the job and leave everything else as it is: " +
      "doc → `edits` (exact find/replace; if the text appears more than once, quote more context or pass `occurrence`) or " +
      "`sections` (replace everything under one heading); sheet → `cells` (e.g. {sheet:\"Budget\", cell:\"C4\", value:\"=B4*12\"}; " +
      "row 1 is the header); slides → `slide_edits` by slide number as read ({index:2, slide:{…}} replaces only slide 2; " +
      "delete / insert_after / move_to). Whole `markdown` / `sheets` / `slides` only for a rewrite the user asked for. " +
      "If an edit is refused as ambiguous, ask the user which one. `title` renames it.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string" },
        version: { type: "number" },
        title: { type: "string" },
        edits: { type: "array", description: "doc: exact text replacements", items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" }, occurrence: { type: "number", description: "1-based, when the text appears more than once" } } } },
        sections: { type: "array", description: "doc: replace the whole section under a heading", items: { type: "object", properties: { heading: { type: "string" }, markdown: { type: "string", description: "new section INCLUDING its heading line" } } } },
        cells: { type: "array", description: "sheet: cell updates", items: { type: "object", properties: { sheet: { type: "string" }, cell: { type: "string" }, value: { type: "string" } } } },
        slide_edits: {
          type: "array",
          description: "slides: per-slide changes, numbered as in read_page (1-based)",
          items: { type: "object", properties: { index: { type: "number" }, slide: { type: "object" }, delete: { type: "boolean" }, insert_after: { type: "object" }, move_to: { type: "number" } }, required: ["index"] },
        },
        ...contentProps,
      },
      required: ["page_id", "version"],
    },
  },
  label: () => "Updated the page",
  async run(args, ctx) {
    const page = await getPage(ctx.userId, str(args, "page_id"));
    const version = Number(args.version);
    if (version !== page.version) return `The page is now at version ${page.version} (it changed since your read). Call read_page and redo the change on the current content.`;
    const result = applyEdits(page.kind, page.content, args as EditArgs);
    if (!result.ok) return result.error;
    const hasContentChange = result.changed.length > 0;
    const updated = await updatePage(ctx.userId, page.id, { title: str(args, "title") || undefined, content: hasContentChange ? result.content : undefined, baseVersion: version, author: "friday" });
    return `Saved "${updated.title}" as version ${updated.version}${hasContentChange ? ` (changed: ${result.changed.join(", ")}; everything else kept)` : ""}. The user's open page refreshes to it.`;
  },
};

export const PAGE_TOOLS = [createPageTool, readPageTool, updatePageTool];
