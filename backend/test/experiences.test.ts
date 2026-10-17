import { test } from "node:test";
import assert from "node:assert/strict";
// The experiences' logic is pure TypeScript shared with the web app; tested here so CI runs it.
import { evaluateOffside, HALFWAY, parseOffsideParams, secondLastOpponent } from "../../frontend/src/lib/experiences/offside.ts";
import { emi, parseEmiParams, schedule } from "../../frontend/src/lib/experiences/emi.ts";
import { flight, parseProjectileParams, trajectory } from "../../frontend/src/lib/experiences/projectile.ts";
import { parseChart } from "../../frontend/src/lib/experiences/chart.ts";
import { parseExperienceBlock } from "../../frontend/src/lib/experiences/registry.ts";

const base = { opponentsX: [82, 101], ballX: 60, involvedInPlay: true, restart: "open_play" as const };

test("offside boundaries: level is onside, 0.1 m beyond is offside", () => {
  assert.equal(evaluateOffside({ ...base, receiverX: 82 }).reason, "level_with_second_last");
  assert.equal(evaluateOffside({ ...base, receiverX: 82 }).inOffsidePosition, false);
  const beyond = evaluateOffside({ ...base, receiverX: 82.1 });
  assert.equal(beyond.inOffsidePosition, true);
  assert.equal(beyond.margin, 0.1);
  assert.equal(evaluateOffside({ ...base, receiverX: 81.9 }).reason, "behind_second_last");
  // Float noise from a drag (82.00000001) still counts as level.
  assert.equal(evaluateOffside({ ...base, receiverX: 82.00000001 }).inOffsidePosition, false);
});

test("own half (incl. the halfway line) and level-with-ball are never offside positions", () => {
  // Defenders pushed up to 40–45 m, ball played from 30 m.
  assert.equal(evaluateOffside({ ...base, ballX: 30, opponentsX: [40, 45], receiverX: HALFWAY }).reason, "own_half");
  assert.equal(evaluateOffside({ ...base, ballX: 30, opponentsX: [40, 45], receiverX: HALFWAY + 0.1 }).inOffsidePosition, true);
  // Receiver beyond the defenders but level with / behind the ball (ball played forward from deep).
  assert.equal(evaluateOffside({ ...base, ballX: 90, receiverX: 90 }).reason, "behind_or_level_with_ball");
  assert.equal(evaluateOffside({ ...base, ballX: 90, receiverX: 88 }).reason, "behind_or_level_with_ball");
});

test("the line is the second-last opponent — the keeper can be the LAST or the second-last", () => {
  assert.equal(secondLastOpponent([82, 101]), 82);
  // Keeper has come out beyond the defender: the defender at 99 is now the LAST, the keeper second-last.
  assert.equal(secondLastOpponent([99, 85]), 85);
  assert.equal(secondLastOpponent([90]), 105, "fewer than two opponents: the goal line stands in");
  assert.equal(evaluateOffside({ ...base, opponentsX: [99, 85], receiverX: 86 }).inOffsidePosition, true);
});

test("offside position ≠ offence: involvement and restarts matter", () => {
  const pos = { ...base, receiverX: 85 };
  assert.equal(evaluateOffside(pos).offence, true);
  assert.equal(evaluateOffside({ ...pos, involvedInPlay: false }).offence, false);
  assert.match(evaluateOffside({ ...pos, involvedInPlay: false }).offenceExplanation, /isn't an offence by itself/);
  for (const restart of ["goal_kick", "throw_in", "corner_kick"] as const) {
    const r = evaluateOffside({ ...pos, restart });
    assert.equal(r.inOffsidePosition, true);
    assert.equal(r.offence, false, restart);
  }
});

test("offside params are bounds-checked (a model or a URL can't push nonsense)", () => {
  assert.deepEqual(parseOffsideParams(undefined)?.receiverX, 80);
  assert.equal(parseOffsideParams({ receiverX: 70.04 })?.receiverX, 70);
  assert.equal(parseOffsideParams({ receiverX: 200 }), null);
  assert.equal(parseOffsideParams({ receiverX: "NaN" }), null);
  assert.equal(parseOffsideParams({ restart: "penalty" }), null);
  assert.equal(parseOffsideParams({ involvedInPlay: "yes" }), null);
  assert.equal(parseOffsideParams("<script>"), null);
});

test("EMI matches the standard formula and the schedule clears the loan exactly", () => {
  // ₹10,00,000 at 9.5% for 20 years → ₹9,321.31 a month (published calculators agree).
  assert.equal(Math.round(emi({ principal: 1_000_000, annualRatePct: 9.5, months: 240 }) * 100) / 100, 9321.31);
  assert.equal(emi({ principal: 120_000, annualRatePct: 0, months: 12 }), 10_000, "0% = equal instalments");
  const s = schedule({ principal: 500_000, annualRatePct: 12, months: 36 });
  assert.equal(s.years.length, 3);
  assert.equal(Math.round(s.years.at(-1)!.balance), 0);
  assert.equal(Math.round(s.years.reduce((n, y) => n + y.principalPaid, 0)), 500_000);
  assert.ok(Math.abs(s.totalPaid - s.monthly * 36) < 0.01, "total paid = EMI × months");
  assert.equal(parseEmiParams({ annualRatePct: 50 }), null);
  assert.equal(parseEmiParams({ months: 13.6 })?.months, 14);
});

test("projectile: 45° goes furthest; known values; the arc starts and ends on the ground", () => {
  const f = flight({ speed: 20, angleDeg: 45, planet: "earth" });
  assert.equal(Math.round(f.range * 100) / 100, 40.77);
  assert.equal(Math.round(f.peak * 100) / 100, 10.19);
  assert.ok(flight({ speed: 20, angleDeg: 30, planet: "earth" }).range < f.range);
  assert.ok(Math.abs(flight({ speed: 20, angleDeg: 30, planet: "earth" }).range - flight({ speed: 20, angleDeg: 60, planet: "earth" }).range) < 1e-9, "complementary angles land together");
  assert.ok(flight({ speed: 20, angleDeg: 45, planet: "moon" }).range > 6 * f.range);
  const arc = trajectory({ speed: 20, angleDeg: 45, planet: "earth" });
  assert.equal(arc[0]!.y, 0);
  assert.ok(Math.abs(arc.at(-1)!.y) < 1e-9);
  assert.equal(parseProjectileParams({ angleDeg: 90 }), null);
  assert.equal(parseProjectileParams({ planet: "pluto" }), null);
});

test("chart and experience blocks: data only, validated, everything else rejected", () => {
  assert.ok(parseChart({ type: "bar", x: ["Q1", "Q2"], series: [{ name: "Revenue", values: [10, 12] }] }));
  assert.equal(parseChart({ type: "pie", x: ["a"], series: [{ name: "s", values: [1] }] }), null);
  assert.equal(parseChart({ type: "bar", x: ["a", "b"], series: [{ name: "s", values: [1] }] }), null, "lengths must match");
  assert.equal(parseChart({ type: "line", x: ["a"], series: [{ name: "s", values: ["1e999"] }] }), null);
  assert.equal(parseChart({ type: "bar", x: Array(61).fill("x"), series: [{ name: "s", values: Array(61).fill(1) }] }), null);
  assert.equal(parseExperienceBlock({ experience: "offside", params: { receiverX: 85 } })?.meta.id, "offside");
  assert.equal(parseExperienceBlock({ experience: "eval", params: {} }), null);
  assert.equal(parseExperienceBlock({ experience: "emi", params: { principal: -5 } }), null);
});

import { sanitizeStructuredBlocks, validStructuredBlock } from "../src/services/chat/structuredBlocks.ts";

test("server and client agree on which blocks are valid", () => {
  const cases: Array<[string, unknown]> = [
    ["friday-chart", { type: "bar", x: ["Q1", "Q2"], series: [{ name: "Revenue", values: [10, 12] }] }],
    ["friday-chart", { type: "pie", x: ["a"], series: [{ name: "s", values: [1] }] }],
    ["friday-chart", { type: "bar", x: ["a", "b"], series: [{ name: "s", values: [1] }] }],
    ["friday-chart", { type: "line", x: ["a"], series: [{ name: "s", values: [Number.MAX_VALUE] }] }],
    ["friday-experience", { experience: "offside", params: { receiverX: 85, restart: "throw_in" } }],
    ["friday-experience", { experience: "offside", params: { receiverX: 200 } }],
    ["friday-experience", { experience: "emi", params: { principal: 500_000, annualRatePct: 9, months: 60 } }],
    ["friday-experience", { experience: "emi", params: { principal: 5 } }],
    ["friday-experience", { experience: "projectile", params: { planet: "pluto" } }],
    ["friday-experience", { experience: "eval", params: {} }],
  ];
  for (const [lang, raw] of cases) {
    const server = validStructuredBlock(lang, JSON.stringify(raw));
    const client = lang === "friday-chart" ? parseChart(raw) !== null : parseExperienceBlock(raw) !== null;
    assert.equal(server, client, `${lang} ${JSON.stringify(raw)}`);
  }
});

test("invalid blocks are saved as plain JSON; valid ones and the rest of the answer are untouched", () => {
  const good = '```friday-chart\n{"type":"bar","x":["A"],"series":[{"name":"s","values":[1]}]}\n```';
  const bad = '```friday-experience\n{"experience":"offside","params":{"receiverX":"<img src=x onerror=alert(1)>"}}\n```';
  const text = `Here's the split:\n\n${good}\n\nAnd a model:\n\n${bad}\n\nDone.`;
  const out = sanitizeStructuredBlocks(text);
  assert.ok(out.includes(good));
  assert.ok(out.includes('```json\n{"experience":"offside"'));
  assert.ok(!out.includes("```friday-experience"));
  assert.ok(out.startsWith("Here's the split:") && out.endsWith("Done."));
  assert.equal(sanitizeStructuredBlocks("plain answer"), "plain answer");
  assert.equal(validStructuredBlock("friday-chart", "{not json"), false);
});
