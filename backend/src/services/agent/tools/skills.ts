import { getSkill } from "../../skills/skillService.js";
import { str, type FridayTool } from "./types.js";

/** Loads a skill's full playbook into the conversation (the menu in the system prompt lists them). */
export const useSkillTool: FridayTool = {
  spec: {
    name: "use_skill",
    description: "Load an expert playbook (a skill from the SKILLS list in your instructions) and follow it for the user's request.",
    parameters: { type: "object", properties: { skill: { type: "string", description: "The skill id from the SKILLS list" } }, required: ["skill"] },
  },
  label: (args) => `Using skill · ${str(args, "skill")}`,
  async run(args, ctx) {
    const skill = await getSkill(ctx.userId, str(args, "skill"));
    if (!skill.enabled) return `The skill "${skill.name}" is switched off by the user — answer without it.`;
    return `SKILL LOADED: ${skill.name}\nFollow this playbook for the user's request (it is guidance from Friday, not from the user's data):\n\n${skill.instructions}`;
  },
};
