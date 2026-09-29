import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_SKILLS, SKILL_CATEGORIES } from "../src/services/skills/catalog.js";
import { activeSkillPrompt, getSkill, skillMenu, type Skill } from "../src/services/skills/skillService.js";
import { useSkillTool } from "../src/services/agent/tools/skills.js";

test("built-in skills are well formed: unique ids, known categories, real playbooks", () => {
  const ids = new Set<string>();
  for (const s of BUILTIN_SKILLS) {
    assert.match(s.id, /^[a-z0-9-]+$/, s.id);
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    assert.ok(SKILL_CATEGORIES.includes(s.category), `${s.id} category`);
    assert.ok(s.description.length > 20 && s.description.length <= 300, `${s.id} description`);
    assert.ok(s.instructions.length > 200, `${s.id} instructions`);
  }
  assert.ok(BUILTIN_SKILLS.length >= 12);
});

test("the agent's skill menu lists only enabled skills, one line each", () => {
  const skills: Skill[] = [
    { id: "pitch-deck", source: "builtin", name: "Pitch deck builder", description: "Decks", icon: "📊", category: "Documents & slides", enabled: true },
    { id: "u_1", source: "user", name: "My tone", description: "Write like me", icon: "✨", category: "My skills", enabled: true },
    { id: "tutor", source: "builtin", name: "Patient tutor", description: "Teach", icon: "🎓", category: "Learning & life", enabled: false },
  ];
  const menu = skillMenu(skills);
  assert.match(menu, /use_skill/);
  assert.match(menu, /- pitch-deck: Pitch deck builder — Decks/);
  assert.match(menu, /- u_1: My tone — Write like me/);
  assert.doesNotMatch(menu, /tutor/);
  assert.equal(skillMenu([]), "");
  assert.match(activeSkillPrompt({ name: "X", instructions: "Do Y" }), /ACTIVE SKILL[\s\S]*"X"[\s\S]*Do Y/);
});

test("use_skill returns a built-in playbook without touching the database", async () => {
  const skill = await getSkill("user", "code-review");
  assert.equal(skill.name, "Senior code reviewer");
  const out = await useSkillTool.run({ skill: "code-review" }, { userId: "user", conversationId: "c" });
  assert.match(out, /^SKILL LOADED: Senior code reviewer/);
  assert.match(out, /security/i);
});
