import { test } from "node:test";
import assert from "node:assert/strict";
import { applySkill, filterToolsForSkill, findSkill, parseSkillDirective, skillsListText, slugOf } from "../src/services/cli/skills.js";
import type { AgentMessage, ToolSpec } from "../src/services/providers/toolCalling.js";
import type { Skill } from "../src/services/skills/skillService.js";

const skills: Skill[] = [
  { id: "pitch-deck", source: "builtin", name: "Pitch deck builder", description: "Decks", icon: "📊", category: "Documents & slides", enabled: true },
  { id: "u_1", source: "user", name: "Release notes", description: "Diff → notes", icon: "📝", category: "My skills", enabled: true, capabilities: ["documents"] },
  { id: "u_2", source: "user", name: "Old thing", description: "", icon: "✨", category: "My skills", enabled: false },
];
const u = (content: string): AgentMessage => ({ role: "user", content });

test("directives: /skills only as the newest message; @name stays active across tool rounds", () => {
  assert.deepEqual(parseSkillDirective([u("/skills")]), { kind: "list" });
  assert.equal(parseSkillDirective([u("/skills"), { role: "assistant", content: "…" } as AgentMessage, u("thanks")]), null);
  const convo: AgentMessage[] = [
    { role: "system", content: "You are FridayX." },
    u("@release-notes write notes for v2.3"),
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read_file", args: {} }] },
    { role: "tool", toolCallId: "a", name: "read_file", content: "diff…" },
  ];
  assert.deepEqual(parseSkillDirective(convo), { kind: "use", ref: "release-notes", messageIndex: 1 });
  assert.equal(parseSkillDirective([u("email me @release-notes")]), null, "only at the start");
});

test("@name resolves by name slug or id, never a switched-off skill", () => {
  assert.equal(slugOf("Pitch deck builder"), "pitch-deck-builder");
  assert.equal(findSkill(skills, "release-notes")?.id, "u_1");
  assert.equal(findSkill(skills, "pitch-deck")?.id, "pitch-deck");
  assert.equal(findSkill(skills, "old-thing"), null);
  assert.match(skillsListText(skills), /@release-notes — Diff → notes/);
  assert.ok(!skillsListText(skills).includes("old-thing"));
});

test("the playbook lands after the client's system prompt and the @prefix is stripped", () => {
  const convo: AgentMessage[] = [{ role: "system", content: "You are FridayX." }, u("@release-notes write notes for v2.3")];
  const out = applySkill(convo, { ...skills[1]!, instructions: "Group by Added/Fixed." }, 1);
  assert.equal(out[0]!.content, "You are FridayX.");
  assert.match(String(out[1]!.content), /ACTIVE SKILL — "Release notes".*may only use: Create and edit documents/s);
  assert.equal(out[2]!.content, "write notes for v2.3");
  assert.equal(convo[1]!.content, "@release-notes write notes for v2.3", "input not mutated");
});

test("a user skill without code/web can't be offered the client's shell or fetch tools", () => {
  const tools = ["read_file", "edit_file", "run_terminal_command", "bash", "web_fetch", "search_files"].map((name): ToolSpec => ({ name, description: "", parameters: { type: "object", properties: {} } }));
  assert.deepEqual(filterToolsForSkill(tools, skills[1]!).map((t) => t.name), ["read_file", "edit_file", "search_files"]);
  assert.equal(filterToolsForSkill(tools, { ...skills[1]!, capabilities: ["code", "web"] }).length, 6);
  assert.equal(filterToolsForSkill(tools, skills[0]!).length, 6, "built-ins don't filter");
});
