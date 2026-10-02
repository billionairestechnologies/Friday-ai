import ExcelJS from "exceljs";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import PDFDocument from "pdfkit";
import pptxgenModule from "pptxgenjs";
import { inlineText, parseMarkdown, type Block, type Inline } from "./markdown.js";

/**
 * Pure renderers: a document spec in, file bytes out. No I/O, no network (images in slides are
 * not fetched — a model-supplied URL must never make the server download things), so every
 * renderer is safe to run on untrusted model output and easy to test.
 */

// pptxgenjs ships CJS typings with `export default`, which NodeNext reads as a namespace; at runtime
// the default import IS the class. Accept either shape.
const PptxGenJS = ((pptxgenModule as unknown as { default?: typeof pptxgenModule.default }).default ?? pptxgenModule) as typeof pptxgenModule.default;

export type DocFormat = "pptx" | "xlsx" | "docx" | "pdf" | "md" | "xml" | "csv" | "json" | "html" | "txt";

export const FORMAT_MIME: Record<DocFormat, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

export type SlideSpec = {
  layout?: "title" | "section" | "bullets" | "two_column" | "stats" | "quote" | "table" | "chart";
  title?: string;
  subtitle?: string;
  bullets?: string[];
  left_title?: string;
  left?: string[];
  right_title?: string;
  right?: string[];
  stats?: { value: string; label: string }[];
  quote?: string;
  table?: string[][];
  chart?: { type?: "bar" | "line" | "pie" | "doughnut"; labels?: string[]; series?: { name?: string; values?: (number | string)[] }[] };
  notes?: string;
};

export type SheetSpec = { name?: string; columns?: string[]; rows?: (string | number | null)[][] };

export type DocumentSpec = {
  format: DocFormat;
  title: string;
  /** Markdown for docx/pdf/md; raw text for xml/csv/json/html/txt. */
  content?: string;
  slides?: SlideSpec[];
  sheets?: SheetSpec[];
  /** Accent colour, e.g. "#4F46E5". */
  theme_color?: string;
  /** txt only: the real file extension for code/config files (py, xaml, yaml, sql, ts, …). */
  extension?: string;
};

/** A safe file extension for a txt-format code/config file, or null. */
export function codeExtension(ext?: string): string | null {
  const e = (ext ?? "").trim().toLowerCase().replace(/^\./, "");
  return /^[a-z0-9]{1,10}$/.test(e) && !["exe", "dll", "bat", "cmd", "com", "scr", "msi", "app", "jar", "apk"].includes(e) ? e : null;
}

export const LIMITS = { slides: 60, sheets: 20, rowsPerSheet: 50_000, contentChars: 400_000 };

function accentHex(color?: string): string {
  const hex = (color ?? "").replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? hex.toUpperCase() : "4F46E5";
}

const s = (v: unknown, max = 2000): string => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
const arr = <T>(v: unknown, max: number): T[] => (Array.isArray(v) ? (v.slice(0, max) as T[]) : []);

// ── PPTX ─────────────────────────────────────────────────────────────────────

export async function renderPptx(spec: DocumentSpec): Promise<Buffer> {
  const accent = accentHex(spec.theme_color);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 × 7.5 in
  pptx.title = s(spec.title, 200);
  pptx.company = "Friday";
  const W = 13.33;
  const FONT = "Calibri";
  pptx.defineSlideMaster({
    title: "CONTENT",
    background: { color: "FFFFFF" },
    objects: [{ rect: { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: accent } } }],
    slideNumber: { x: W - 0.9, y: 6.95, w: 0.6, h: 0.3, color: "9CA3AF", fontSize: 10, fontFace: FONT },
  });
  pptx.defineSlideMaster({ title: "ACCENT", background: { color: accent }, objects: [] });

  const slides = arr<SlideSpec>(spec.slides, LIMITS.slides);
  if (!slides.length) slides.push({ layout: "title", title: spec.title });

  slides.forEach((slide, index) => {
    const layout = slide.layout ?? (index === 0 ? "title" : slide.stats ? "stats" : slide.chart ? "chart" : slide.table ? "table" : slide.left || slide.right ? "two_column" : slide.quote ? "quote" : "bullets");
    const accentSlide = layout === "title" || layout === "section";
    const sl = pptx.addSlide({ masterName: accentSlide ? "ACCENT" : "CONTENT" });
    const title = s(slide.title, 200);

    if (accentSlide) {
      sl.addText(title || s(spec.title, 200), { x: 0.9, y: layout === "title" ? 2.4 : 2.8, w: W - 1.8, h: 1.4, fontFace: FONT, fontSize: layout === "title" ? 44 : 36, bold: true, color: "FFFFFF" });
      if (slide.subtitle) sl.addText(s(slide.subtitle, 300), { x: 0.9, y: layout === "title" ? 3.9 : 4.2, w: W - 1.8, h: 0.8, fontFace: FONT, fontSize: 20, color: "E5E7EB" });
    } else {
      if (title) sl.addText(title, { x: 0.6, y: 0.35, w: W - 1.2, h: 0.9, fontFace: FONT, fontSize: 30, bold: true, color: "111827" });
      if (slide.subtitle && layout !== "quote") sl.addText(s(slide.subtitle, 300), { x: 0.6, y: 1.15, w: W - 1.2, h: 0.5, fontFace: FONT, fontSize: 16, color: "6B7280" });
      const top = slide.subtitle && layout !== "quote" ? 1.8 : 1.45;
      const bulletList = (items: string[], x: number, y: number, w: number, h: number, size = 20) =>
        sl.addText(
          items.map((t) => ({ text: s(t, 500), options: { bullet: { indent: 18 }, breakLine: true } })),
          { x, y, w, h, fontFace: FONT, fontSize: size, color: "374151", valign: "top", paraSpaceAfter: 10 },
        );

      if (layout === "two_column") {
        const colW = (W - 1.6) / 2;
        [["left_title", "left", 0.6], ["right_title", "right", 0.6 + colW + 0.4]].forEach(([tk, lk, x]) => {
          const heading = s(slide[tk as "left_title" | "right_title"], 120);
          if (heading) sl.addText(heading, { x: x as number, y: top, w: colW, h: 0.5, fontFace: FONT, fontSize: 20, bold: true, color: accent });
          bulletList(arr<string>(slide[lk as "left" | "right"], 12), x as number, top + (heading ? 0.6 : 0), colW, 5.9 - top - (heading ? 0.6 : 0), 18);
        });
      } else if (layout === "stats") {
        const stats = arr<{ value: string; label: string }>(slide.stats, 4);
        const cardW = (W - 1.2 - (stats.length - 1) * 0.3) / Math.max(1, stats.length);
        stats.forEach((st, i) => {
          const x = 0.6 + i * (cardW + 0.3);
          sl.addShape(pptx.ShapeType.roundRect, { x, y: top + 0.4, w: cardW, h: 2.6, fill: { color: "F3F4F6" }, line: { color: "F3F4F6" }, rectRadius: 0.15 });
          sl.addText(s(st?.value, 40), { x, y: top + 0.7, w: cardW, h: 1.2, fontFace: FONT, fontSize: 44, bold: true, color: accent, align: "center" });
          sl.addText(s(st?.label, 120), { x: x + 0.2, y: top + 1.9, w: cardW - 0.4, h: 0.9, fontFace: FONT, fontSize: 16, color: "4B5563", align: "center", valign: "top" });
        });
        if (slide.bullets?.length) bulletList(arr<string>(slide.bullets, 6), 0.6, top + 3.4, W - 1.2, 2.6, 16);
      } else if (layout === "quote") {
        sl.addText(`“${s(slide.quote || slide.bullets?.[0], 600)}”`, { x: 1.2, y: 1.8, w: W - 2.4, h: 3, fontFace: "Georgia", fontSize: 30, italic: true, color: "111827", valign: "middle" });
        if (slide.subtitle) sl.addText(`— ${s(slide.subtitle, 200)}`, { x: 1.2, y: 5, w: W - 2.4, h: 0.6, fontFace: FONT, fontSize: 18, color: "6B7280" });
      } else if (layout === "table") {
        const rows = arr<string[]>(slide.table, 16).map((r) => arr<string>(r, 8).map((c) => s(c, 200)));
        if (rows.length) {
          sl.addTable(
            rows.map((r, ri) => r.map((c) => ({ text: c, options: ri === 0 ? { bold: true, color: "FFFFFF", fill: { color: accent } } : { color: "374151" } }))),
            { x: 0.6, y: top, w: W - 1.2, fontFace: FONT, fontSize: 14, border: { type: "solid", color: "E5E7EB", pt: 1 }, autoPage: false },
          );
        }
      } else if (layout === "chart") {
        const chart = slide.chart ?? {};
        const labels = arr<string>(chart.labels, 30).map((l) => s(l, 60));
        const series = arr<{ name?: string; values?: (number | string)[] }>(chart.series, 6).map((se) => ({
          name: s(se?.name, 60) || "Series",
          labels,
          values: arr<number | string>(se?.values, 30).map((v) => Number(v) || 0),
        }));
        const type = (["bar", "line", "pie", "doughnut"] as const).find((t) => t === chart.type) ?? "bar";
        if (series.length && labels.length) {
          sl.addChart(type, series, { x: 0.6, y: top, w: W - 1.2, h: 6.7 - top, showLegend: series.length > 1 || chart.type === "pie" || chart.type === "doughnut", legendPos: "b", chartColors: [accent, "10B981", "F59E0B", "EF4444", "8B5CF6", "06B6D4"], valAxisLabelFontSize: 12, catAxisLabelFontSize: 12 });
        }
      } else {
        bulletList(arr<string>(slide.bullets, 12), 0.6, top, W - 1.2, 6.6 - top);
      }
    }
    if (slide.notes) sl.addNotes(s(slide.notes, 4000));
  });

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

// ── XLSX ─────────────────────────────────────────────────────────────────────

const NUMERIC = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export function coerceCell(value: unknown): string | number | { formula: string } | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value);
  if (text.startsWith("=") && text.length > 1) return { formula: text.slice(1) };
  // "0123" stays text (ids, phone numbers); "1,234.5" → 1234.5.
  const plain = text.replace(/,/g, "");
  if (NUMERIC.test(plain) && !/^-?0\d/.test(plain)) return Number(plain);
  return text.slice(0, 32_000);
}

export async function renderXlsx(spec: DocumentSpec): Promise<Buffer> {
  const accent = accentHex(spec.theme_color);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Friday";
  wb.title = s(spec.title, 200);
  const sheets = arr<SheetSpec>(spec.sheets, LIMITS.sheets);
  if (!sheets.length) sheets.push({ name: "Sheet1", columns: [], rows: [] });
  const used = new Set<string>();
  sheets.forEach((sheet, i) => {
    // Excel sheet names: ≤31 chars, no []:*?/\ and unique.
    let name = s(sheet.name, 31).replace(/[[\]:*?/\\]/g, " ").trim() || `Sheet${i + 1}`;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${i + 1}`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: sheet.columns?.length ? 1 : 0 }] });
    const columns = arr<string>(sheet.columns, 200).map((c) => s(c, 200));
    const rows = arr<(string | number | null)[]>(sheet.rows, LIMITS.rowsPerSheet);
    if (columns.length) {
      const header = ws.addRow(columns);
      header.font = { bold: true, color: { argb: "FFFFFFFF" } };
      header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${accent}` } };
      header.alignment = { vertical: "middle" };
    }
    for (const row of rows) ws.addRow(arr<unknown>(row, 200).map(coerceCell));
    const width = Math.max(columns.length, ...rows.slice(0, 500).map((r) => (Array.isArray(r) ? r.length : 0)));
    for (let c = 1; c <= width; c++) {
      const lengths = [columns[c - 1] ?? "", ...rows.slice(0, 500).map((r) => s(Array.isArray(r) ? r[c - 1] : "", 200))].map((t) => t.length);
      ws.getColumn(c).width = Math.min(60, Math.max(10, ...lengths) + 2);
    }
    if (columns.length && rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── DOCX ─────────────────────────────────────────────────────────────────────

function docxRuns(inlines: Inline[], base: { bold?: boolean; size?: number; color?: string } = {}) {
  return inlines.map((i) => {
    const run = new TextRun({ text: i.text, bold: base.bold || i.bold, italics: i.italic, size: base.size, color: base.color, ...(i.code ? { font: "Consolas", shading: { type: ShadingType.CLEAR, fill: "F3F4F6", color: "auto" } } : {}), ...(i.link ? { style: "Hyperlink" } : {}) });
    return i.link && /^https?:\/\//.test(i.link) ? new ExternalHyperlink({ link: i.link, children: [run] }) : run;
  });
}

export async function renderDocx(spec: DocumentSpec): Promise<Buffer> {
  const accent = accentHex(spec.theme_color);
  const blocks = parseMarkdown(s(spec.content, LIMITS.contentChars));
  const hasH1 = blocks[0]?.type === "heading" && blocks[0].level === 1;
  const children: (Paragraph | Table)[] = [];
  if (!hasH1) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: s(spec.title, 200) })] }));
  let listInstance = 0;
  const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
  for (const block of blocks) {
    if (block.type === "heading") children.push(new Paragraph({ heading: HEADINGS[block.level - 1], spacing: { before: 240, after: 120 }, children: docxRuns(block.inlines) }));
    else if (block.type === "paragraph") children.push(new Paragraph({ spacing: { after: 160 }, children: docxRuns(block.inlines) }));
    else if (block.type === "quote") children.push(new Paragraph({ indent: { left: 480 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: accent, space: 12 } }, children: docxRuns(block.inlines.map((i) => ({ ...i, italic: true })), { color: "4B5563" }) }));
    else if (block.type === "hr") children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "D1D5DB", space: 1 } }, children: [] }));
    else if (block.type === "code") {
      for (const line of block.text.split("\n")) children.push(new Paragraph({ shading: { type: ShadingType.CLEAR, fill: "F3F4F6", color: "auto" }, spacing: { after: 0 }, children: [new TextRun({ text: line || " ", font: "Consolas", size: 18 })] }));
      children.push(new Paragraph({ children: [] }));
    } else if (block.type === "list") {
      listInstance++;
      for (const item of block.items) {
        children.push(new Paragraph({ ...(block.ordered ? { numbering: { reference: "ordered", level: 0, instance: listInstance } } : { bullet: { level: 0 } }), spacing: { after: 80 }, children: docxRuns(item) }));
      }
    } else if (block.type === "table") {
      const cols = Math.max(block.header.length, ...block.rows.map((r) => r.length));
      const cell = (inlines: Inline[], header: boolean) =>
        new TableCell({
          children: [new Paragraph({ children: docxRuns(inlines, header ? { bold: true, color: "FFFFFF" } : {}) })],
          ...(header ? { shading: { type: ShadingType.CLEAR, fill: accent, color: "auto" } } : {}),
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
        });
      const pad = (r: Inline[][]) => [...r, ...Array.from({ length: cols - r.length }, () => [] as Inline[])];
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ tableHeader: true, children: pad(block.header).map((c) => cell(c, true)) }), ...block.rows.map((r) => new TableRow({ children: pad(r).map((c) => cell(c, false)) }))],
        }),
      );
      children.push(new Paragraph({ children: [] }));
    }
  }
  const doc = new Document({
    creator: "Friday",
    title: s(spec.title, 200),
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: { config: [{ reference: "ordered", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
    sections: [{ children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

// ── PDF ──────────────────────────────────────────────────────────────────────

const PDF_REPLACEMENTS: [RegExp, string][] = [
  [/₹/g, "Rs. "], [/→/g, "->"], [/←/g, "<-"], [/≥/g, ">="], [/≤/g, "<="], [/≠/g, "!="], [/✓|✔|☑/g, "(yes)"], [/✗|✘|❌/g, "(no)"], [/[“”]/g, '"'], [/[‘’]/g, "'"],
];
// The standard PDF fonts only cover Windows-1252; anything else would print as garbage.
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
export function pdfSafe(text: string): string {
  let out = text;
  for (const [re, rep] of PDF_REPLACEMENTS) out = out.replace(re, rep);
  return [...out].filter((ch) => { const c = ch.codePointAt(0)!; return c === 10 || c === 9 || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN_ANSI_EXTRA.includes(ch); }).join("");
}

export async function renderPdf(spec: DocumentSpec): Promise<Buffer> {
  const accent = `#${accentHex(spec.theme_color)}`;
  const doc = new PDFDocument({ size: "A4", margins: { top: 64, bottom: 64, left: 60, right: 60 }, bufferPages: true, info: { Title: pdfSafe(s(spec.title, 200)), Author: "Friday", Creator: "Friday" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const finished = new Promise<void>((resolve) => doc.on("end", () => resolve()));
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };

  const runs = (inlines: Inline[], opts: { size?: number; color?: string; bold?: boolean; x?: number; w?: number } = {}) => {
    const list = inlines.length ? inlines : [{ text: " " }];
    list.forEach((i, idx) => {
      const font = i.code ? "Courier" : (opts.bold || i.bold) && i.italic ? "Helvetica-BoldOblique" : opts.bold || i.bold ? "Helvetica-Bold" : i.italic ? "Helvetica-Oblique" : "Helvetica";
      doc.font(font).fontSize(opts.size ?? 11).fillColor(i.link ? accent : opts.color ?? "#1F2937");
      const textOpts = { continued: idx < list.length - 1, lineGap: 3, ...(i.link && /^https?:\/\//.test(i.link) ? { link: i.link, underline: true } : { link: null, underline: false }) };
      if (idx === 0 && opts.x !== undefined) doc.text(pdfSafe(i.text), opts.x, doc.y, { ...textOpts, width: opts.w });
      else doc.text(pdfSafe(i.text), textOpts);
    });
    doc.x = left;
  };

  const blocks = parseMarkdown(s(spec.content, LIMITS.contentChars));
  if (!(blocks[0]?.type === "heading" && blocks[0].level === 1)) {
    doc.font("Helvetica-Bold").fontSize(24).fillColor("#111827").text(pdfSafe(s(spec.title, 200)), { width });
    doc.moveDown(0.3);
    doc.rect(left, doc.y, 48, 3).fill(accent);
    doc.moveDown(1.2);
  }
  const SIZES = [22, 17, 14, 12];
  for (const block of blocks) {
    if (block.type === "heading") {
      ensure(40);
      doc.moveDown(block.level <= 2 ? 0.6 : 0.4);
      runs(block.inlines, { size: SIZES[block.level - 1], bold: true, color: "#111827" });
      doc.moveDown(0.3);
    } else if (block.type === "paragraph") {
      ensure(20);
      runs(block.inlines);
      doc.moveDown(0.6);
    } else if (block.type === "quote") {
      ensure(24);
      const y = doc.y;
      runs(block.inlines.map((i) => ({ ...i, italic: true })), { color: "#4B5563", x: left + 14, w: width - 14 });
      doc.rect(left, y, 3, doc.y - y).fill(accent);
      doc.moveDown(0.6);
    } else if (block.type === "hr") {
      ensure(16);
      doc.moveTo(left, doc.y + 4).lineTo(left + width, doc.y + 4).strokeColor("#D1D5DB").lineWidth(1).stroke();
      doc.moveDown(1);
    } else if (block.type === "code") {
      const text = pdfSafe(block.text) || " ";
      doc.font("Courier").fontSize(9);
      const h = doc.heightOfString(text, { width: width - 16 }) + 14;
      ensure(Math.min(h, 200));
      const y = doc.y;
      doc.rect(left, y, width, h).fill("#F3F4F6");
      doc.fillColor("#111827").text(text, left + 8, y + 7, { width: width - 16 });
      doc.x = left;
      doc.y = Math.max(doc.y, y + h);
      doc.moveDown(0.6);
    } else if (block.type === "list") {
      block.items.forEach((item, n) => {
        ensure(18);
        const y = doc.y;
        doc.font("Helvetica").fontSize(11).fillColor(accent).text(block.ordered ? `${n + 1}.` : "•", left + 4, y, { width: 16 });
        doc.y = y;
        runs(item, { x: left + 20, w: width - 20 });
        doc.moveDown(0.25);
      });
      doc.moveDown(0.4);
    } else if (block.type === "table") {
      const cols = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
      const colW = width / cols;
      const drawRow = (cells: Inline[][], header: boolean) => {
        const texts = Array.from({ length: cols }, (_, c) => pdfSafe(inlineText(cells[c] ?? [])) || " ");
        doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(9.5);
        const h = Math.max(...texts.map((t) => doc.heightOfString(t, { width: colW - 10 }))) + 10;
        if (doc.y + h > bottom()) doc.addPage();
        const y = doc.y;
        if (header) doc.rect(left, y, width, h).fill(accent);
        texts.forEach((t, c) => {
          doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor(header ? "#FFFFFF" : "#1F2937").text(t, left + c * colW + 5, y + 5, { width: colW - 10 });
        });
        doc.moveTo(left, y + h).lineTo(left + width, y + h).strokeColor("#E5E7EB").lineWidth(0.8).stroke();
        doc.x = left;
        doc.y = y + h;
      };
      drawRow(block.header, true);
      block.rows.forEach((r) => drawRow(r, false));
      doc.moveDown(0.8);
    }
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(8.5).fillColor("#9CA3AF").text(`${pdfSafe(s(spec.title, 80))}  ·  ${i + 1} / ${range.count}`, left, doc.page.height - 40, { width, align: "center", lineBreak: false });
    doc.page.margins.bottom = oldBottom;
  }
  doc.end();
  await finished;
  return Buffer.concat(chunks);
}

// ── Text formats ─────────────────────────────────────────────────────────────

export function renderText(spec: DocumentSpec): Buffer {
  let content = s(spec.content, LIMITS.contentChars);
  if (spec.format === "json") {
    try {
      content = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      throw new Error("The JSON content isn't valid JSON — fix it and try again.");
    }
  } else if (spec.format === "xml" && !content.trimStart().startsWith("<?xml")) {
    content = `<?xml version="1.0" encoding="UTF-8"?>\n${content.trimStart()}`;
  } else if (spec.format === "csv" && !content && spec.sheets?.length) {
    const sheet = spec.sheets[0]!;
    const esc = (v: unknown) => { const t = s(v, 32_000); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    content = [sheet.columns ?? [], ...(sheet.rows ?? [])].filter((r) => r.length).map((r) => r.map(esc).join(",")).join("\n");
  }
  // A BOM so Excel opens UTF-8 CSVs with the right characters.
  return Buffer.from(spec.format === "csv" ? `﻿${content}` : content, "utf8");
}

export async function renderDocument(spec: DocumentSpec): Promise<Buffer> {
  switch (spec.format) {
    case "pptx":
      return renderPptx(spec);
    case "xlsx":
      return renderXlsx(spec);
    case "docx":
      return renderDocx(spec);
    case "pdf":
      return renderPdf(spec);
    default:
      return renderText(spec);
  }
}

export function describeSpec(spec: DocumentSpec): string {
  if (spec.format === "pptx") return `${spec.slides?.length ?? 0} slides`;
  if (spec.format === "xlsx") return `${spec.sheets?.length ?? 0} sheet${spec.sheets?.length === 1 ? "" : "s"}, ${(spec.sheets ?? []).reduce((n, sh) => n + (sh.rows?.length ?? 0), 0)} rows`;
  const blocks: Block[] = spec.format === "docx" || spec.format === "pdf" ? parseMarkdown(spec.content ?? "") : [];
  if (blocks.length) return `${blocks.filter((b) => b.type === "heading").length} sections`;
  return `${(spec.content ?? "").length.toLocaleString()} characters`;
}
