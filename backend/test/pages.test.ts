import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContent } from "../src/services/pages/pageService.js";
import { PAGE_TOOLS, parseCellRef } from "../src/services/agent/tools/pages.js";

test("page content is normalised per kind with sane defaults and limits", () => {
  assert.deepEqual(normalizeContent("doc", { markdown: "# Hi" }), { markdown: "# Hi" });
  assert.deepEqual(normalizeContent("doc", {}), { markdown: "" });
  const sheet = normalizeContent("sheet", { sheets: [{ name: "Budget", columns: ["Item", 2], rows: [["Rent", 25000, null]] }] }) as { sheets: { name: string; columns: string[]; rows: string[][] }[] };
  assert.deepEqual(sheet.sheets[0], { name: "Budget", columns: ["Item", "2"], rows: [["Rent", "25000", ""]] });
  const empty = normalizeContent("sheet", {}) as { sheets: unknown[] };
  assert.equal(empty.sheets.length, 1, "a new sheet starts with one tab");
  const slides = normalizeContent("slides", {}) as { slides: { layout: string }[] };
  assert.equal(slides.slides[0]!.layout, "title");
  assert.throws(() => normalizeContent("doc", { markdown: "x".repeat(500_000) }), /too long/);
});

test("A1 cell references map to header (row -1) and data rows", () => {
  assert.deepEqual(parseCellRef("A1"), { row: -1, col: 0 });
  assert.deepEqual(parseCellRef("C4"), { row: 2, col: 2 });
  assert.deepEqual(parseCellRef("AA10"), { row: 8, col: 26 });
  assert.equal(parseCellRef("4C"), null);
});

test("page tools stay inside the schema subset every dialect accepts", () => {
  for (const t of PAGE_TOOLS) {
    assert.ok(!JSON.stringify(t.spec.parameters).includes("additionalProperties"), t.spec.name);
    for (const r of t.spec.parameters.required ?? []) assert.ok(r in t.spec.parameters.properties, `${t.spec.name}.${r}`);
  }
});
