import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import JSZip from "jszip";
import { renderDocument } from "../src/services/documents/render.js";
import { archiveKind, extractArchiveBuffer, extractArchiveText } from "../src/services/providers/archiveDocs.js";
import { extractOfficeBuffer, officeKind } from "../src/services/providers/officeDocs.js";
import { extractPdfBuffer } from "../src/services/providers/pdfText.js";
import { decodeTextBuffer, isPlainTextDocument, isTextFileName } from "../src/services/providers/plainTextDocs.js";

const dataUrl = (buf: Buffer, mime = "application/octet-stream") => `data:${mime};base64,${buf.toString("base64")}`;

/** A ustar archive built by hand (header + 512-byte padded bodies + two zero blocks). */
function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(Buffer.byteLength(body).toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h);
    const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
    data.write(body);
    blocks.push(data);
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test("file kinds come from the mime OR the extension (browsers often send octet-stream)", () => {
  assert.equal(archiveKind("application/octet-stream", "src.zip"), "zip");
  assert.equal(archiveKind("", "backup.tar.gz"), "tgz");
  assert.equal(archiveKind("application/vnd.rar", "x"), "rar");
  assert.equal(archiveKind("application/pdf", "a.pdf"), null);
  assert.equal(officeKind("application/octet-stream", "Deck.PPTX"), "pptx");
  assert.equal(officeKind("application/vnd.oasis.opendocument.text"), "odt");
  assert.ok(isPlainTextDocument("application/octet-stream", "MainWindow.xaml"));
  assert.ok(isTextFileName("project/Dockerfile"));
  assert.equal(decodeTextBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1])), null, "binary content is refused");
});

test("zip: listing + readable files (code, docx inside), junk folders hidden", async () => {
  const docx = await renderDocument({ format: "docx", title: "Spec", content: "# Spec\n\nThe budget is 42 lakh." });
  const zip = new JSZip();
  zip.file("app/main.py", "print('hello friday')\n");
  zip.file("app/MainWindow.xaml", "<Window Title=\"Friday\"/>");
  zip.file("docs/spec.docx", docx);
  zip.file("node_modules/left-pad/index.js", "module.exports = 1");
  zip.file("__MACOSX/._main.py", "junk");
  zip.file("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const buf = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
  const text = (await extractArchiveText(dataUrl(buf, "application/zip"), "application/zip", "project.zip"))!;
  assert.match(text, /Archive project\.zip — 4 files/);
  assert.match(text, /- logo\.png/);
  assert.match(text, /== app\/main\.py ==\nprint\('hello friday'\)/);
  assert.match(text, /Title="Friday"/);
  assert.match(text, /The budget is 42 lakh/);
  assert.doesNotMatch(text, /left-pad|__MACOSX/);
});

test("tar.gz and single .gz files are opened", async () => {
  const tgz = gzipSync(tar({ "repo/README.md": "# Friday", "repo/src/index.ts": "export const x = 1;" }));
  const text = (await extractArchiveBuffer(tgz, "tgz", "repo.tgz"))!;
  assert.match(text, /2 files/);
  assert.match(text, /== repo\/src\/index\.ts ==\nexport const x = 1;/);
  const gz = (await extractArchiveBuffer(gzipSync(Buffer.from("line one\nline two")), "gz", "server.log.gz"))!;
  assert.match(gz, /server\.log \(gzip\)[\s\S]*line two/);
});

test("corrupt archives fail soft (null), never throw into the chat turn", async () => {
  assert.equal(await extractArchiveText(dataUrl(Buffer.from("not a zip at all")), "application/zip", "bad.zip"), null);
  assert.equal(await extractArchiveText(dataUrl(Buffer.from("Rar!garbage")), "application/vnd.rar", "bad.rar"), null);
});

test("pptx text, slide by slide, with speaker notes", async () => {
  const pptx = await renderDocument({
    format: "pptx",
    title: "Q3",
    slides: [
      { layout: "title", title: "Q3 Review", subtitle: "Friday AI" },
      { layout: "bullets", title: "Wins", bullets: ["Revenue up 30%", "Churn down"], notes: "Mention the Android launch" },
    ],
  });
  const text = (await extractOfficeBuffer(pptx, "pptx"))!;
  assert.match(text, /== Slide 1 ==[\s\S]*Q3 Review/);
  assert.match(text, /== Slide 2 ==[\s\S]*Revenue up 30%/);
  assert.match(text, /Speaker notes\] Mention the Android launch/);
});

test("xlsx keeps formulas next to their values", async () => {
  const xlsx = await renderDocument({ format: "xlsx", title: "Budget", sheets: [{ name: "Costs", columns: ["Item", "Cost"], rows: [["A", "10"], ["B", "20"], ["Total", "=SUM(B2:B3)"]] }] });
  const text = (await extractOfficeBuffer(xlsx, "xlsx"))!;
  assert.match(text, /== Sheet: Costs ==/);
  assert.match(text, /\[=SUM\(B2:B3\)\]/);
});

test("text PDFs are read locally, page by page", async () => {
  const pdf = await renderDocument({ format: "pdf", title: "Invoice", content: "# Invoice 1042\n\nTotal due: 18,500.75 INR\n\nThank you for your business." });
  const out = (await extractPdfBuffer(pdf))!;
  assert.equal(out.scanned, false);
  assert.match(out.text, /--- Page 1 ---/);
  assert.match(out.text, /18,500\.75/);
});
