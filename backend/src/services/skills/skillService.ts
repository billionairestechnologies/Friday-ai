import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { memoAsync } from "../../utils/ttlMemo.js";
import { entitlementsFor } from "../quota/entitlements.js";
import { BUILTIN_SKILLS, builtinSkill, type SkillCategory } from "./catalog.js";

/**
 * Skills for one user: the built-in catalog (each switchable off) plus skills they wrote. The agent
 * sees the enabled ones as a short menu (name + when to use) and loads a full playbook with the
 * use_skill tool; a skill the user picks in the composer is pinned into the turn directly.
 */

export type Skill = {
  id: string;
  source: "builtin" | "user";
  name: string;
  description: string;
  icon: string;
  category: SkillCategory | "My skills";
  enabled: boolean;
  instructions?: string;
};

const USER_PREFIX = "u_";

type UserSkillRow = { id: string; name: string; description: string; instructions: string; icon: string; enabled: boolean };

async function loadUserSkills(userId: string): Promise<UserSkillRow[]> {
  const { data, error } = await supabaseAdmin.from("user_skills").select("id, name, description, instructions, icon, enabled").eq("user_id", userId).order("created_at", { ascending: true });
  if (error) return []; // before migration 0036
  return (data ?? []) as UserSkillRow[];
}

async function loadPrefs(userId: string): Promise<Map<string, boolean>> {
  const { data, error } = await supabaseAdmin.from("user_skill_prefs").select("skill_id, enabled").eq("user_id", userId);
  if (error) return new Map();
  return new Map((data ?? []).map((r) => [r.skill_id as string, r.enabled as boolean]));
}

async function listSkillsUncached(userId: string): Promise<Skill[]> {
  const [own, prefs] = await Promise.all([loadUserSkills(userId), loadPrefs(userId)]);
  return [
    ...BUILTIN_SKILLS.map((s) => ({ id: s.id, source: "builtin" as const, name: s.name, description: s.description, icon: s.icon, category: s.category, enabled: prefs.get(s.id) ?? true })),
    ...own.map((s) => ({ id: `${USER_PREFIX}${s.id}`, source: "user" as const, name: s.name, description: s.description, icon: s.icon || "✨", category: "My skills" as const, enabled: s.enabled })),
  ];
}

/** Read at the start of every tool-capable chat turn — cached briefly, invalidated on every edit. */
export const listSkills = memoAsync(30_000, listSkillsUncached, (userId) => userId);

export async function getSkill(userId: string, id: string): Promise<Skill & { instructions: string }> {
  const builtin = builtinSkill(id);
  if (builtin) return { id: builtin.id, source: "builtin", name: builtin.name, description: builtin.description, icon: builtin.icon, category: builtin.category, enabled: true, instructions: builtin.instructions };
  if (id.startsWith(USER_PREFIX)) {
    const { data } = await supabaseAdmin.from("user_skills").select("id, name, description, instructions, icon, enabled").eq("user_id", userId).eq("id", id.slice(USER_PREFIX.length)).maybeSingle();
    if (data) return { id, source: "user", name: data.name as string, description: data.description as string, icon: (data.icon as string) || "✨", category: "My skills", enabled: data.enabled as boolean, instructions: data.instructions as string };
  }
  // Models sometimes pass the skill's name instead of its id.
  const byName = (await listSkills(userId)).find((s) => s.name.toLowerCase() === id.trim().toLowerCase());
  if (byName && byName.id !== id) return getSkill(userId, byName.id);
  throw new HttpError(404, "No such skill");
}

export type SkillInput = { name: string; description?: string; instructions: string; icon?: string; enabled?: boolean };

export async function createSkill(userId: string, input: SkillInput) {
  const allowed = (await entitlementsFor(userId)).customSkills;
  const { count } = await supabaseAdmin.from("user_skills").select("id", { count: "exact", head: true }).eq("user_id", userId);
  if ((count ?? 0) >= allowed) throw new HttpError(403, allowed > 0 ? `Your plan includes up to ${allowed} custom skills — delete one or upgrade for more.` : "Custom skills aren't included in your plan — upgrade to create them.");
  const { data, error } = await supabaseAdmin
    .from("user_skills")
    .insert({ user_id: userId, name: input.name, description: input.description ?? "", instructions: input.instructions, icon: input.icon || "✨", enabled: input.enabled ?? true })
    .select("id")
    .single();
  if (error || !data) throw new HttpError(400, error?.message ?? "Couldn't save the skill");
  listSkills.invalidate(userId);
  return getSkill(userId, `${USER_PREFIX}${data.id}`);
}

export async function updateSkill(userId: string, id: string, input: Partial<SkillInput>) {
  if (!id.startsWith(USER_PREFIX)) throw new HttpError(400, "Built-in skills can only be switched on or off");
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of ["name", "description", "instructions", "icon", "enabled"] as const) if (input[key] !== undefined) patch[key] = input[key];
  const { error } = await supabaseAdmin.from("user_skills").update(patch).eq("user_id", userId).eq("id", id.slice(USER_PREFIX.length));
  if (error) throw new HttpError(400, error.message);
  listSkills.invalidate(userId);
  return getSkill(userId, id);
}

export async function deleteSkill(userId: string, id: string) {
  if (!id.startsWith(USER_PREFIX)) throw new HttpError(400, "Built-in skills can't be deleted — switch them off instead");
  const { error } = await supabaseAdmin.from("user_skills").delete().eq("user_id", userId).eq("id", id.slice(USER_PREFIX.length));
  if (error) throw new HttpError(500, error.message);
  listSkills.invalidate(userId);
}

export async function setSkillEnabled(userId: string, id: string, enabled: boolean) {
  if (id.startsWith(USER_PREFIX)) return updateSkill(userId, id, { enabled });
  if (!builtinSkill(id)) throw new HttpError(404, "No such skill");
  const { error } = await supabaseAdmin.from("user_skill_prefs").upsert({ user_id: userId, skill_id: id, enabled, updated_at: new Date().toISOString() }, { onConflict: "user_id,skill_id" });
  if (error) throw new HttpError(500, error.message);
  listSkills.invalidate(userId);
}

/** The menu the agent sees: enabled skills, one line each. */
export function skillMenu(skills: Skill[]): string {
  const enabled = skills.filter((s) => s.enabled);
  if (!enabled.length) return "";
  return [
    "SKILLS — expert playbooks you can load. When the user's request clearly matches one, call use_skill with its id FIRST (once), then follow the playbook it returns. Don't load a skill for small talk or quick questions.",
    ...enabled.map((s) => `- ${s.id}: ${s.name} — ${s.description}`),
  ].join("\n");
}

/** A skill the user picked for this turn, as a pinned system message. */
export function activeSkillPrompt(skill: { name: string; instructions: string }): string {
  return `ACTIVE SKILL — the user chose "${skill.name}" for this conversation. Follow this playbook for the request:\n\n${skill.instructions}`;
}
