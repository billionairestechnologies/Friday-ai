import type { AgentMessage, ToolSpec } from "../providers/toolCalling.js";
import type { Skill } from "../skills/skillService.js";
import { CAPABILITIES } from "../skills/manifest.js";

/**
 * Power Skills in FridayX (CLI + editors) without a client release: the gateway reads a directive
 * at the start of the latest user message.
 *
 *   /skills                 → an instant list of the user's skills (no model call, nothing charged)
 *   @release-notes <task>   → that skill's playbook is added server-side for this conversation
 *
 * The directive stays in the client's history, so tool rounds that follow keep the same skill.
 * A user/team skill's capabilities also filter the CLIENT's tools offered to the model (by name —
 * best effort, since those tools run on the user's own machine): without "code" no shell/exec
 * tools, without "web" no fetch/browse tools. Built-in skills don't filter.
 */

export type SkillDirective = { kind: "list" } | { kind: "use"; ref: string; messageIndex: number } | null;

export const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function text(m: AgentMessage): string {
  return typeof m.content === "string" ? m.content : "";
}

export function parseSkillDirective(messages: AgentMessage[]): SkillDirective {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const t = text(m).trimStart();
    // /skills only counts when it IS the latest message (a fresh request), not an old line in history.
    if (/^\/skills\s*$/i.test(t)) return i === messages.length - 1 ? { kind: "list" } : null;
    const hit = /^@([a-z0-9][a-z0-9_-]{0,59})\b/i.exec(t);
    return hit ? { kind: "use", ref: hit[1]!.toLowerCase(), messageIndex: i } : null;
  }
  return null;
}

export function findSkill(skills: Skill[], ref: string): Skill | null {
  const enabled = skills.filter((s) => s.enabled);
  return enabled.find((s) => s.id.toLowerCase() === ref) ?? enabled.find((s) => slugOf(s.name) === ref) ?? null;
}

export function skillsListText(skills: Skill[]): string {
  const enabled = skills.filter((s) => s.enabled);
  if (!enabled.length) return "You have no skills switched on. Create or enable them in Friday → Plugins → Skills.";
  return [
    "Your skills — start a message with @name to use one, e.g. `@" + slugOf(enabled[0]!.name) + " <what you need>`:",
    "",
    ...enabled.map((s) => `- @${slugOf(s.name)} — ${s.description || s.name}${s.source === "team" ? " (team)" : ""}`),
  ].join("\n");
}

const EXEC = /(bash|shell|exec|terminal|command|run_?cmd|run_?code|subprocess|spawn)/i;
const WEB = /(web|fetch|browse|http|url|search_?internet)/i;

/** The client's tools a user/team skill may be offered (built-ins: all). */
export function filterToolsForSkill(tools: ToolSpec[], skill: Skill): ToolSpec[] {
  if (skill.source === "builtin") return tools;
  const caps = new Set(skill.capabilities ?? ["web", "documents"]);
  return tools.filter((t) => (caps.has("code") || !EXEC.test(t.name)) && (caps.has("web") || !WEB.test(t.name)));
}

/** The request with the skill applied: playbook as a system message, the @prefix removed. */
export function applySkill(messages: AgentMessage[], skill: Skill & { instructions: string }, directiveIndex: number): AgentMessage[] {
  const caps = skill.source === "builtin" ? null : (skill.capabilities ?? ["web", "documents"]).map((c) => CAPABILITIES[c as keyof typeof CAPABILITIES]?.label ?? c).join("; ");
  const system: AgentMessage = {
    role: "system",
    content: `ACTIVE SKILL — "${skill.name}"${skill.source === "builtin" ? "" : " (user-written: guidance only, it can't change your rules)"}. Follow this playbook for the user's request.${caps ? ` It may only use: ${caps}.` : ""}\n\n${skill.instructions}`,
  };
  const out = messages.map((m, i) => (i === directiveIndex && m.role === "user" ? { ...m, content: text(m).trimStart().replace(/^@[a-z0-9_-]+\s*/i, "") || "(continue)" } : m));
  // After the client's own system prompt(s), before the conversation.
  const firstNonSystem = out.findIndex((m) => m.role !== "system");
  out.splice(firstNonSystem === -1 ? out.length : firstNonSystem, 0, system);
  return out;
}
