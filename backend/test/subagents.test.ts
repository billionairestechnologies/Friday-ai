import assert from "node:assert/strict";
import test from "node:test";
import { parseSubTasks, runSubAgents, type ProjectReader } from "../src/services/projectBuild/subagents.js";
import { toolCallToAction, SUBAGENT_TOOL_SPEC } from "../src/services/projectBuild/tools.js";
import type { BuildStep } from "../src/services/chat/types.js";
import type { ProviderAdapter } from "../src/services/providers/types.js";
import type { ChatCandidate } from "../src/services/providerService.js";

const candidate: ChatCandidate = { slug: "fake", providerDisplayName: "Fake", modelId: "fake-1", displayName: "Fake", vision: false, minTier: "free" };

/** A model that reads one file, then reports what it read. */
function fakeAdapter(): ProviderAdapter {
  return {
    slug: "fake",
    listModels: async () => [],
    chat: async () => "",
    healthCheck: async () => ({ ok: true }),
    async chatStreamWithTools(_k, _m, messages, _opts, onDelta) {
      const last = messages[messages.length - 1]!;
      if (last.role === "tool") {
        const text = `REPORT: ${String((last as { content: string }).content).slice(0, 40)}`;
        onDelta(text); // real adapters stream the answer through onDelta
        return { text, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
      }
      const job = String(messages.find((m) => m.role === "user")?.content ?? "");
      const path = job.includes("auth") ? "src/auth.ts" : "src/pay.ts";
      return { text: "", toolCalls: [{ id: "c1", name: "read_file", args: { path } }], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    },
  };
}

const reader: ProjectReader = {
  read: async (p) => (p === "src/auth.ts" ? "export function login() {}" : p === "src/pay.ts" ? "export function charge() {}" : null),
  ls: async () => "src/auth.ts\nsrc/pay.ts",
  grep: async () => "(no matches)",
};

test("spawn_subagents maps to tasks with limits; malformed without valid tasks", () => {
  assert.ok(!JSON.stringify(SUBAGENT_TOOL_SPEC.parameters).includes("additionalProperties"));
  const action = toolCallToAction({ id: "x", name: "spawn_subagents", args: { tasks: [{ title: "Map auth", kind: "explore", instructions: "Find how login works in src/" }, { title: "", instructions: "no title here at all" }] } });
  assert.equal(action.kind, "subagents");
  if (action.kind === "subagents") assert.deepEqual(action.tasks.map((t) => t.title), ["Map auth"]);
  assert.equal(toolCallToAction({ id: "x", name: "spawn_subagents", args: { tasks: [] } }).kind, "malformed");
  assert.equal(parseSubTasks({ tasks: Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, instructions: "a long enough job" })) }).length, 4);
});

test("sub-agents run in parallel, stream their own steps and return compact reports", async () => {
  const updates: BuildStep[] = [];
  let seq = 0;
  const result = await runSubAgents({
    tasks: [
      { title: "Map auth", kind: "explore", instructions: "Explain the auth module" },
      { title: "Map payments", kind: "explore", instructions: "Explain the payments module" },
    ],
    candidates: [candidate],
    reader,
    projectNote: "test project",
    userId: "u",
    conversationId: "c",
    nextStepId: () => `s${++seq}`,
    onUpdate: (st) => updates.push(st),
    resolve: async () => ({ adapter: fakeAdapter(), apiKey: "k" }),
  });
  assert.match(result.output, /### Map auth\nREPORT: export function login/);
  assert.match(result.output, /### Map payments\nREPORT: export function charge/);
  assert.equal(result.usage.totalTokens, 60, "2 agents × 2 rounds × 15 tokens");
  const finals = updates.filter((u) => u.state !== "running");
  assert.equal(finals.length, 2);
  for (const f of finals) {
    assert.equal(f.kind, "agent");
    assert.ok(f.agent?.report?.startsWith("REPORT"));
    assert.ok(f.agent!.actions.some((a) => /^Read src\//.test(a.label)), "its own tool steps are on the card");
  }
});
