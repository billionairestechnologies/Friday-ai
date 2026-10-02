import assert from "node:assert/strict";
import test from "node:test";
import { renderDocument } from "../src/services/documents/render.js";
import { chunkText } from "../src/services/knowledge/chunking.js";
import { toVectorLiteral } from "../src/services/knowledge/embeddings.js";
import { extractText } from "../src/services/knowledge/projectKnowledge.js";
import { projectSearchTool } from "../src/services/agent/tools/projectSearch.js";

test("chunks: ~1200 chars, overlapping, cut at boundaries, nothing lost", () => {
  const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(40).trim()}.`);
  const text = paras.join("\n\n");
  const chunks = chunkText(text);
  assert.ok(chunks.length > 3);
  for (const c of chunks) assert.ok(c.length <= 1300, `chunk too long: ${c.length}`);
  for (const p of paras) assert.ok(chunks.some((c) => c.includes(p.slice(0, 30))), `lost ${p.slice(0, 15)}`);
  // overlap: the next chunk starts with text the previous one already ended with
  assert.ok(chunks[0]!.includes(chunks[1]!.slice(0, 40)), "consecutive chunks should overlap");
  assert.deepEqual(chunkText("short"), ["short"]);
  assert.deepEqual(chunkText("   "), []);
});

test("page/slide headers travel with the chunks after them", () => {
  const text = `--- Page 1 ---\n${"alpha ".repeat(300)}\n--- Page 2 ---\n${"beta ".repeat(300)}`;
  const chunks = chunkText(text);
  const betaChunk = chunks.find((c) => c.includes("beta") && !c.includes("alpha"))!;
  assert.match(betaChunk, /--- Page 2 ---/);
});

test("a long single document is chunked quickly (linear, not quadratic)", () => {
  const big = "Sentence about revenue growth. ".repeat(60_000); // ~1.9M chars
  const t = Date.now();
  const chunks = chunkText(big);
  assert.ok(chunks.length > 1000);
  assert.ok(Date.now() - t < 3000, "chunking took too long");
});

test("project files are read with the same readers as attachments", async () => {
  const docx = await renderDocument({ format: "docx", title: "Policy", content: "# Leave policy\n\nEmployees get 24 days of paid leave." });
  assert.match(await extractText(docx, "policy.docx", "application/octet-stream"), /24 days of paid leave/);
  assert.match(await extractText(Buffer.from("name,role\nAsha,Support"), "team.csv", "text/csv"), /Asha,Support/);
  await assert.rejects(extractText(Buffer.from([1, 2, 3]), "x.bin", "application/x-msdownload"), /can't read/);
});

test("pgvector literal + tool spec", () => {
  assert.equal(toVectorLiteral([0.5, -0.25]), "[0.5000000,-0.2500000]");
  const tool = projectSearchTool("p", ["policy.docx", "pricing.xlsx"]);
  assert.equal(tool.spec.name, "search_project_files");
  assert.match(tool.spec.description, /policy\.docx, pricing\.xlsx/);
  assert.ok(!JSON.stringify(tool.spec.parameters).includes("additionalProperties"));
});
