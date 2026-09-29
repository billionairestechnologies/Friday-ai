import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { parseInline, parseMarkdown } from "../src/services/documents/markdown.js";
import { coerceCell, pdfSafe, renderDocument } from "../src/services/documents/render.js";
import { safeFilename } from "../src/services/documents/documentService.js";
import { createDocumentTool } from "../src/services/agent/tools/documents.js";

test("markdown parser: headings, lists, tables, code, quotes and inline styles", () => {
  const blocks = parseMarkdown("# Title\n\nSome **bold** and *it* with `code` and [a link](https://x.com).\n\n- one\n- two\n\n1. first\n2. second\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nlet x;\n```\n\n> quoted\n\n---");
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "list", "list", "table", "code", "quote", "hr"]);
  const para = blocks[1]!;
  assert.ok(para.type === "paragraph" && para.inlines.some((i) => i.bold && i.text === "bold") && para.inlines.some((i) => i.link === "https://x.com"));
  const table = blocks[4]!;
  assert.ok(table.type === "table" && table.rows.length === 1 && table.header.length === 2);
  assert.deepEqual(parseInline("plain"), [{ text: "plain" }]);
});

test("spreadsheet cells: numbers detected, ids and phone numbers stay text, = makes a formula", () => {
  assert.equal(coerceCell("1,234.50"), 1234.5);
  assert.equal(coerceCell("-7"), -7);
  assert.equal(coerceCell("0123"), "0123");
  assert.deepEqual(coerceCell("=SUM(A1:A3)"), { formula: "SUM(A1:A3)" });
  assert.equal(coerceCell(""), null);
  assert.equal(coerceCell("hello"), "hello");
});

test("PDF text is mapped to what the standard fonts can print", () => {
  assert.equal(pdfSafe("₹500 → done ✓"), "Rs. 500 -> done (yes)");
  assert.equal(pdfSafe("café — “quote”"), 'café — "quote"');
  assert.equal(pdfSafe("hi 🚀 नमस्ते"), "hi  ");
});

test("file names are safe and carry the right extension", () => {
  assert.equal(safeFilename("Q3 Review: Final/v2?", "pptx"), "Q3 Review Finalv2.pptx");
  assert.equal(safeFilename("report.docx", "docx"), "report.docx");
  assert.equal(safeFilename("🚀", "pdf"), "document.pdf");
});

test("every format renders a real file", async () => {
  const pptx = await renderDocument({ format: "pptx", title: "Deck", slides: [{ layout: "title", title: "Deck" }, { title: "Points", bullets: ["a", "b"] }, { layout: "chart", title: "C", chart: { type: "bar", labels: ["x", "y"], series: [{ name: "s", values: [1, 2] }] } }] });
  const zip = await JSZip.loadAsync(pptx);
  assert.equal(Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length, 3);

  const xlsx = await renderDocument({ format: "xlsx", title: "Sheet", sheets: [{ name: "Data", columns: ["n"], rows: [["1"], ["=A2*2"]] }] });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx);
  assert.equal(wb.getWorksheet("Data")!.getCell("A2").value, 1);

  const docx = await renderDocument({ format: "docx", title: "Doc", content: "# Hello\n\n- a\n- b" });
  assert.equal(docx.subarray(0, 2).toString(), "PK");
  const pdf = await renderDocument({ format: "pdf", title: "Doc", content: "# Hello\n\nWorld\n\n| a | b |\n|---|---|\n| 1 | 2 |" });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");

  assert.equal((await renderDocument({ format: "json", title: "j", content: '{"a":1}' })).toString(), '{\n  "a": 1\n}');
  await assert.rejects(() => renderDocument({ format: "json", title: "j", content: "{nope" }), /valid JSON/);
  assert.ok((await renderDocument({ format: "xml", title: "x", content: "<a/>" })).toString().startsWith("<?xml"));
  assert.equal((await renderDocument({ format: "csv", title: "c", sheets: [{ columns: ["a"], rows: [["x,y"]] }] })).toString(), '﻿a\n"x,y"');
});

test("create_document rejects incomplete specs before touching storage", async () => {
  const ctx = { userId: "u", conversationId: "c" };
  await assert.rejects(() => createDocumentTool.run({ format: "exe", title: "x" }, ctx), /format must be/);
  await assert.rejects(() => createDocumentTool.run({ format: "pptx", title: "x" }, ctx), /needs `slides`/);
  await assert.rejects(() => createDocumentTool.run({ format: "xlsx", title: "x" }, ctx), /needs `sheets`/);
  await assert.rejects(() => createDocumentTool.run({ format: "docx", title: "x", content: "  " }, ctx), /needs `content`/);
});
