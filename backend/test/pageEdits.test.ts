import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, diffContent, diffLines } from "../src/services/pages/pageEdits.js";

const doc = { markdown: "# Proposal\n\nIntro text.\n\n## Pricing\n\nPro costs ₹999.\nPremium costs ₹1999.\n\n## Timeline\n\nQ1 launch.\n" };

test("doc: a targeted edit changes only its text; ambiguous or missing targets change nothing", () => {
  const r = applyEdits("doc", doc, { edits: [{ find: "₹999.", replace: "₹1,099." }] });
  assert.ok(r.ok);
  assert.equal((r.content as { markdown: string }).markdown, doc.markdown.replace("Pro costs ₹999.", "Pro costs ₹1,099."));
  const twice = applyEdits("doc", doc, { edits: [{ find: "costs", replace: "is" }] });
  assert.equal(twice.ok, false);
  assert.match((twice as { error: string }).error, /appears 2 times/);
  const second = applyEdits("doc", doc, { edits: [{ find: "costs", replace: "is", occurrence: 2 }] });
  assert.ok(second.ok && (second.content as { markdown: string }).markdown.includes("Pro costs ₹999.\nPremium is ₹1999."));
  assert.equal(applyEdits("doc", doc, { edits: [{ find: "nope" }] }).ok, false);
});

test("doc: replace one section under a heading, keep the others byte-for-byte", () => {
  const r = applyEdits("doc", doc, { sections: [{ heading: "Pricing", markdown: "## Pricing\n\nOne plan: ₹1,499." }] });
  assert.ok(r.ok);
  const md = (r.content as { markdown: string }).markdown;
  assert.ok(md.startsWith("# Proposal\n\nIntro text.\n\n## Pricing\n\nOne plan: ₹1,499.\n\n## Timeline\n\nQ1 launch.\n"), md);
  assert.equal(applyEdits("doc", { markdown: "## A\nx\n## A\ny" }, { sections: [{ heading: "A", markdown: "## A\nz" }] }).ok, false, "duplicate headings → ask");
  // A '#' line inside a code block is not a heading.
  const code = { markdown: "## Setup\n```bash\n# install\nnpm i\n```\nDone.\n## Next\nmore" };
  const c = applyEdits("doc", code, { sections: [{ heading: "Setup", markdown: "## Setup\nNew." }] });
  assert.ok(c.ok);
  assert.equal((c.content as { markdown: string }).markdown, "## Setup\nNew.\n\n## Next\nmore");
});

test("sheet: one cell changes; a multi-sheet workbook needs the sheet named", () => {
  const sheet = { sheets: [{ name: "Budget", columns: ["Item", "Cost"], rows: [["Hosting", "100"], ["Mail", "20"]] }] };
  const r = applyEdits("sheet", sheet, { cells: [{ cell: "B3", value: "25" }] });
  assert.ok(r.ok);
  assert.deepEqual((r.content as typeof sheet).sheets[0]!.rows, [["Hosting", "100"], ["Mail", "25"]]);
  assert.deepEqual(sheet.sheets[0]!.rows[1], ["Mail", "20"], "the input is not mutated");
  const two = { sheets: [...sheet.sheets, { name: "Q2", columns: ["x"], rows: [] }] };
  assert.equal(applyEdits("sheet", two, { cells: [{ cell: "B3", value: "1" }] }).ok, false);
});

test("slides: 'change only slide two' leaves every other slide identical; delete/insert/move use the numbers as read", () => {
  const slides = { slides: [1, 2, 3, 4].map((n) => ({ layout: "bullets", title: `S${n}`, bullets: [`point ${n}`] })) as never[], theme_color: "#123456" };
  const r = applyEdits("slides", slides, { slide_edits: [{ index: 2, slide: { layout: "bullets", title: "New S2", bullets: ["x"] } as never }] });
  assert.ok(r.ok);
  const out = (r.content as typeof slides).slides as Array<{ title: string }>;
  assert.deepEqual(out.map((s) => s.title), ["S1", "New S2", "S3", "S4"]);
  assert.deepEqual(out[0], slides.slides[0]);
  assert.equal((r.content as typeof slides).theme_color, "#123456");
  const combo = applyEdits("slides", slides, { slide_edits: [{ index: 1, delete: true }, { index: 3, slide: { title: "New S3" } as never }, { index: 4, move_to: 1 }] });
  assert.ok(combo.ok);
  assert.deepEqual(((combo.content as typeof slides).slides as Array<{ title: string }>).map((s) => s.title), ["S4", "S2", "New S3"]);
  assert.equal(applyEdits("slides", slides, { slide_edits: [{ index: 9, delete: true }] }).ok, false);
});

test("diffs: doc lines, changed cells, changed slides", () => {
  const d = diffContent("doc", { markdown: "a\nb\nc" }, { markdown: "a\nB\nc\nd" });
  assert.equal(d.kind, "doc");
  assert.deepEqual(d.kind === "doc" && [d.added, d.removed], [2, 1]);
  assert.deepEqual(diffLines("x\ny", "x\ny"), [{ op: "same", text: "x" }, { op: "same", text: "y" }]);
  const s = diffContent("sheet", { sheets: [{ name: "S", columns: ["A"], rows: [["1"]] }] }, { sheets: [{ name: "S", columns: ["A"], rows: [["2"]] }, { name: "T", columns: [], rows: [] }] });
  assert.deepEqual(s.kind === "sheet" && [s.cells, s.sheetsAdded], [[{ sheet: "S", cell: "A2", before: "1", after: "2" }], ["T"]]);
  const sl = diffContent("slides", { slides: [{ title: "A" }, { title: "B" }] as never[] }, { slides: [{ title: "A" }, { title: "B2" }, { title: "C" }] as never[] });
  assert.deepEqual(sl.kind === "slides" && sl.slides.map((x) => x.change), ["changed", "added"]);
});
