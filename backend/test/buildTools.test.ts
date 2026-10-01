import assert from "node:assert/strict";
import test from "node:test";
import { BUILD_TOOL_SPECS, INTERACTION_TOOL_SPECS, compactToolCallArgs, parseAskQuestions, toolCallToAction } from "../src/services/projectBuild/tools.js";
import type { ToolCall } from "../src/services/providers/toolCalling.js";

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: "c", name, args });

test("build tool specs stay inside the schema subset every dialect accepts", () => {
  const names = new Set<string>();
  for (const spec of BUILD_TOOL_SPECS) {
    assert.ok(!names.has(spec.name), `duplicate tool ${spec.name}`);
    names.add(spec.name);
    assert.equal(spec.parameters.type, "object");
    // Gemini rejects additionalProperties; keep specs free of it.
    assert.ok(!JSON.stringify(spec.parameters).includes("additionalProperties"));
    for (const req of spec.parameters.required ?? []) assert.ok(req in spec.parameters.properties, `${spec.name}.${req}`);
  }
  for (const needed of ["write_file", "edit_file", "run_command", "start_server", "check_app", "finish"]) assert.ok(names.has(needed));
});

test("tool calls map onto the shared BuildAction executor", () => {
  assert.deepEqual(toolCallToAction(call("write_file", { path: "src/a.js", content: "x" })), { kind: "write", path: "src/a.js", content: "x" });
  assert.deepEqual(toolCallToAction(call("edit_file", { path: "a.js", old_string: "a", new_string: "b" })), {
    kind: "edit",
    path: "a.js",
    edits: [{ search: "a", replace: "b" }],
  });
  assert.deepEqual(toolCallToAction(call("run_command", { command: "npm install" })), { kind: "run", cmd: "npm install", desc: "npm install" });
  assert.deepEqual(toolCallToAction(call("start_server", { command: "npm run dev", port: "5173", description: "Dev" })), {
    kind: "start",
    cmd: "npm run dev",
    port: 5173,
    desc: "Dev",
  });
  assert.deepEqual(toolCallToAction(call("list_files", {})), { kind: "ls", path: "." });
  assert.deepEqual(toolCallToAction(call("grep", { pattern: "useState" })), { kind: "grep", pattern: "useState", path: "." });
  assert.deepEqual(toolCallToAction(call("check_app", {})), { kind: "check" });
  assert.deepEqual(toolCallToAction(call("finish", { summary: " Done " })), { kind: "done", summary: "Done" });
  // An empty file is a legitimate write.
  assert.deepEqual(toolCallToAction(call("write_file", { path: ".env.example", content: "" })), { kind: "write", path: ".env.example", content: "" });
});

test("bad or truncated tool calls come back as malformed with an actionable reason", () => {
  // A reply cut off by the output-token limit parses to {} → no content.
  const truncated = toolCallToAction(call("write_file", { path: "src/huge.js" }));
  assert.equal(truncated.kind, "malformed");
  assert.match((truncated as { reason: string }).reason, /split it/);
  assert.equal(toolCallToAction(call("start_server", { command: "x", port: 99999 })).kind, "malformed");
  assert.equal(toolCallToAction(call("run_command", {})).kind, "malformed");
  assert.equal(toolCallToAction(call("rm_rf", {})).kind, "malformed");
});

test("compactToolCallArgs drops old file bodies but keeps the latest turns intact", () => {
  const big = "x".repeat(5000);
  const messages = [
    { role: "assistant", content: "", toolCalls: [call("write_file", { path: "a", content: big })] },
    { role: "tool", content: "ok" },
    { role: "assistant", content: "", toolCalls: [call("write_file", { path: "b", content: big })] },
    { role: "tool", content: "ok" },
    { role: "assistant", content: "", toolCalls: [call("edit_file", { path: "c", old_string: big, new_string: big })] },
  ];
  compactToolCallArgs(messages, 2);
  assert.match(String(messages[0]!.toolCalls![0]!.args.content), /omitted/);
  assert.equal(messages[2]!.toolCalls![0]!.args.content, big);
  assert.equal(messages[4]!.toolCalls![0]!.args.old_string, big);
  assert.equal(messages[0]!.toolCalls![0]!.args.path, "a");
});

test("interaction tool specs follow the same schema rules and are NOT in the default build toolset", () => {
  const defaults = new Set(BUILD_TOOL_SPECS.map((t) => t.name));
  for (const spec of INTERACTION_TOOL_SPECS) {
    assert.ok(!defaults.has(spec.name), `${spec.name} must only exist in the model-driven flow`);
    assert.ok(!JSON.stringify(spec.parameters).includes("additionalProperties"));
    for (const req of spec.parameters.required ?? []) assert.ok(req in spec.parameters.properties, `${spec.name}.${req}`);
  }
  assert.deepEqual(INTERACTION_TOOL_SPECS.map((t) => t.name).sort(), ["ask_user", "propose_plan"]);
});

test("ask_user becomes question cards: limits applied, first option recommended", () => {
  const action = toolCallToAction(
    call("ask_user", {
      questions: [
        { question: "Which stack?", options: [{ label: "React + Vite", description: "fast" }, { label: "Next.js" }, { label: "Vue" }, { label: "Svelte" }, { label: "Extra" }] },
        { question: "Broken", options: [{ label: "only one" }] },
      ],
    }),
  );
  assert.equal(action.kind, "ask");
  if (action.kind !== "ask") return;
  assert.equal(action.questions.length, 1, "a question with fewer than 2 options is dropped");
  assert.equal(action.questions[0]!.options.length, 4);
  assert.equal(action.questions[0]!.options[0]!.recommended, true);
  assert.equal(action.questions[0]!.options[1]!.recommended, false);
  assert.equal(action.questions[0]!.id, "q1");
  assert.deepEqual(parseAskQuestions({ questions: "nope" }), []);
  assert.equal(toolCallToAction(call("ask_user", { questions: [] })).kind, "malformed");
});

test("propose_plan needs real steps; checkbox prefixes are stripped and steps capped", () => {
  const ok = toolCallToAction(call("propose_plan", { summary: "A CRM", architecture: "Vite + Express", steps: ["- [ ] Scaffold", "Build API", "Run it"] }));
  assert.equal(ok.kind, "plan");
  if (ok.kind === "plan") assert.deepEqual(ok.items, ["Scaffold", "Build API", "Run it"]);
  const many = toolCallToAction(call("propose_plan", { summary: "x", architecture: "y", steps: Array.from({ length: 30 }, (_, i) => `step ${i}`) }));
  if (many.kind === "plan") assert.equal(many.items.length, 12);
  assert.equal(toolCallToAction(call("propose_plan", { summary: "x", steps: ["only one"] })).kind, "malformed");
});
