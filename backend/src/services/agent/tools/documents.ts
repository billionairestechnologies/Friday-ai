import { createDocument } from "../../documents/documentService.js";
import { LIMITS, type DocFormat, type DocumentSpec, type SheetSpec, type SlideSpec } from "../../documents/render.js";
import { str, type FridayTool } from "./types.js";

const FORMATS: DocFormat[] = ["pptx", "xlsx", "docx", "pdf", "md", "xml", "csv", "json", "html", "txt"];
const FORMAT_LABEL: Record<DocFormat, string> = {
  pptx: "presentation", xlsx: "spreadsheet", docx: "Word document", pdf: "PDF", md: "Markdown file", xml: "XML file", csv: "CSV file", json: "JSON file", html: "HTML file", txt: "text file",
};

const stringList = { type: "array", items: { type: "string" } };

/**
 * create_document: the model writes the CONTENT (slides, sheets, Markdown), Friday renders a real
 * file. Never the other way round — no code execution, no templates fetched from the web.
 */
export const createDocumentTool: FridayTool = {
  spec: {
    name: "create_document",
    description:
      "Create a downloadable file for the user: a PowerPoint presentation (pptx), Excel spreadsheet (xlsx), Word document " +
      "(docx), PDF, or a Markdown/XML/CSV/JSON/HTML/text file. Use it whenever the user asks for a presentation, deck, slides, " +
      "spreadsheet, sheet, table to download, report, document, letter, resume, invoice, PDF or a file in one of these formats. " +
      "Research or compute the content first (web_search, run_code) so the file is complete and accurate — never placeholders. " +
      "The file appears as a download card under your reply and in the user's Library, so after creating it just say what " +
      "it contains; don't paste the whole content again.\n" +
      "- pptx: fill `slides` (6-15 is typical). Layouts: title (first slide), section, bullets (3-6 short bullets), two_column " +
      "(left/right lists), stats (2-4 big numbers), quote, table (rows of cells, first row is the header), chart (bar/line/pie/" +
      "doughnut with labels + numeric series). Put talking points in `notes`.\n" +
      "- xlsx: fill `sheets` with `columns` and `rows` (cells as strings; numbers are detected; start a cell with = for a formula, e.g. \"=SUM(B2:B9)\").\n" +
      "- docx / pdf / md: write the whole document as Markdown in `content` (headings, paragraphs, lists, tables, quotes, code). " +
      "PDF uses standard fonts: Latin text only — for Hindi or other scripts prefer docx.\n" +
      "- xml / csv / json / html / txt: put the exact file text in `content` (csv may use `sheets` instead).",
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", enum: FORMATS, description: "File type" },
        title: { type: "string", description: "Document title; also the file name" },
        content: { type: "string", description: "Markdown (docx/pdf/md) or the raw file text (xml/csv/json/html/txt)" },
        slides: {
          type: "array",
          description: "pptx only",
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
              stats: { type: "array", items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" } } } },
              quote: { type: "string" },
              table: { type: "array", items: stringList },
              chart: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["bar", "line", "pie", "doughnut"] },
                  labels: stringList,
                  series: { type: "array", items: { type: "object", properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } } } },
                },
              },
              notes: { type: "string", description: "Speaker notes" },
            },
          },
        },
        sheets: {
          type: "array",
          description: "xlsx (or csv) only",
          items: { type: "object", properties: { name: { type: "string" }, columns: stringList, rows: { type: "array", items: stringList } } },
        },
        theme_color: { type: "string", description: "Optional accent colour as hex, e.g. #4F46E5" },
      },
      required: ["format", "title"],
    },
  },
  label: (args) => `Creating ${FORMAT_LABEL[(str(args, "format") as DocFormat)] ?? "a document"}${str(args, "title") ? ` · ${str(args, "title").slice(0, 60)}` : ""}`,
  async run(args, ctx) {
    const format = str(args, "format").toLowerCase().replace(/^\./, "") as DocFormat;
    if (!FORMATS.includes(format)) throw new Error(`format must be one of ${FORMATS.join(", ")}`);
    const title = str(args, "title") || "Document";
    const spec: DocumentSpec = {
      format,
      title,
      content: typeof args.content === "string" ? args.content : undefined,
      slides: Array.isArray(args.slides) ? (args.slides as SlideSpec[]) : undefined,
      sheets: Array.isArray(args.sheets) ? (args.sheets as SheetSpec[]) : undefined,
      theme_color: str(args, "theme_color") || undefined,
    };
    if (format === "pptx" && !spec.slides?.length) throw new Error("A presentation needs `slides`.");
    if (format === "xlsx" && !spec.sheets?.length) throw new Error("A spreadsheet needs `sheets`.");
    if (["docx", "pdf", "md", "xml", "json", "html", "txt"].includes(format) && !spec.content?.trim()) throw new Error("This format needs `content`.");
    if ((spec.content?.length ?? 0) > LIMITS.contentChars) throw new Error("The content is too long for one file — split it into parts.");
    const file = await createDocument(ctx.userId, ctx.conversationId, spec);
    ctx.onFile?.(file);
    return `Created ${file.filename} (${file.summary}, ${Math.max(1, Math.round(file.size / 1024))} KB). The user sees a download card for it under your reply and it's saved in their Library.`;
  },
};
