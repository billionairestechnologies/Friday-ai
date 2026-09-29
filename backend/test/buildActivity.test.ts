import assert from "node:assert/strict";
import test from "node:test";
import { CODE_PREVIEW_LINES, codePreview, editDiff, langForPath, tailText, throttledOutput } from "../src/services/projectBuild/activity.js";
import { applySummary, planSummaryCut, renderTranscript, transcriptChars } from "../src/services/projectBuild/summarize.js";
import type { AgentMessage } from "../src/services/providers/toolCalling.js";
import { toolCallToAction } from "../src/services/projectBuild/tools.js";

test("langForPath maps extensions and special names", () => {
  assert.equal(langForPath("src/App.tsx"), "tsx");
  assert.equal(langForPath("server.py"), "python");
  assert.equal(langForPath("Dockerfile"), "dockerfile");
  assert.equal(langForPath(".env.local"), "bash");
  assert.equal(langForPath("LICENSE"), "text");
});

test("codePreview keeps the start of a file, capped, and counts lines", () => {
  const small = codePreview("a\nb\nc\n");
  assert.equal(small.code, "a\nb\nc\n");
  assert.equal(small.added, 3);
  const big = codePreview(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
  assert.equal(big.added, 100);
  assert.match(big.code, /… 60 more lines$/);
  assert.equal(big.code.split("\n").length, CODE_PREVIEW_LINES + 1);
});

test("editDiff shows only the changed lines, not shared context", () => {
  const d = editDiff([{ search: "function a() {\n  return 1;\n}", replace: "function a() {\n  return 2;\n}" }]);
  assert.equal(d.code, "-   return 1;\n+   return 2;");
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  const pure = editDiff([{ search: "x", replace: "x\ny" }]);
  assert.equal(pure.code, "+ y");
  assert.deepEqual([pure.added, pure.removed], [1, 0]);
});

test("tailText keeps the newest output and starts on a line boundary", () => {
  assert.equal(tailText("short", 100), "short");
  const t = tailText("aaaa\nbbbb\ncccc", 8);
  assert.ok(t.startsWith("…"));
  assert.ok(t.endsWith("cccc"));
});

test("throttledOutput coalesces chunks into few emits", async () => {
  const seen: string[] = [];
  const out = throttledOutput((o) => seen.push(o), 20);
  for (let i = 0; i < 50; i++) out.push(`line ${i}\n`);
  await new Promise((r) => setTimeout(r, 40));
  out.stop();
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /line 49/);
});

test("web tools map onto the build executor", () => {
  assert.deepEqual(toolCallToAction({ id: "1", name: "web_search", args: { query: "vite 5 config" } }), {
    kind: "web",
    tool: "web_search",
    args: { query: "vite 5 config" },
  });
  assert.equal(toolCallToAction({ id: "1", name: "fetch_url", args: {} }).kind, "malformed");
});

function transcript(rounds: number): AgentMessage[] {
  const msgs: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "build a todo app" }];
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: "assistant", content: `round ${i}`, toolCalls: [{ id: `c${i}`, name: "write_file", args: { path: `f${i}.js`, content: "x".repeat(100) } }] });
    msgs.push({ role: "tool", toolCallId: `c${i}`, name: "write_file", content: "ok" });
  }
  return msgs;
}

test("summary cut never separates a tool result from its call and keeps recent turns", () => {
  const msgs = transcript(10);
  const cut = planSummaryCut(msgs, 5);
  assert.ok(cut > 2);
  assert.equal(msgs[cut]!.role, "assistant");
  assert.equal(planSummaryCut(transcript(1), 5), -1);
  const next = applySummary(msgs, cut, "SUMMARY", "build a todo app");
  assert.equal(next[0]!.role, "system");
  assert.equal(next[1]!.role, "user");
  assert.match(next[1]!.content, /SUMMARY/);
  assert.equal(next[2]!.role, "assistant");
  // Every kept tool result still follows its assistant call.
  const ids = new Set<string>();
  for (const m of next) {
    if ("toolCalls" in m && m.toolCalls) m.toolCalls.forEach((c) => ids.add(c.id));
    if (m.role === "tool") assert.ok(ids.has(m.toolCallId));
  }
  assert.ok(transcriptChars(next) < transcriptChars(msgs));
});

test("renderTranscript hides file bodies and system text", () => {
  const text = renderTranscript(transcript(2));
  assert.ok(!text.includes("sys"));
  assert.match(text, /CALL write_file .*\(100 chars\)/);
  assert.match(text, /RESULT \(write_file\): ok/);
});
