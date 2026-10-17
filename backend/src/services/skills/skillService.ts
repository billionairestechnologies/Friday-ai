import { supabaseAdmin } from "../../config/supabase.js";
import { checkEval, lintManifest, manifestHash, manifestSchema, type Capability, type EvalCase, type EvalResult, type SkillManifest } from "./manifest.js";
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
  /** User skills: declared capability groups (null = the safe default set). Built-ins: unrestricted. */
  capabilities?: string[] | null;
  status?: "draft" | "published" | "disabled";
  version?: number;
};

const USER_PREFIX = "u_";

type UserSkillRow = { id: string; name: string; description: string; instructions: string; icon: string; enabled: boolean; status?: string; version?: number; capabilities?: string[] | null };
const USER_COLUMNS = "id, name, description, instructions, icon, enabled, status, version, capabilities";

async function loadUserSkills(userId: string): Promise<UserSkillRow[]> {
  const full = await supabaseAdmin.from("user_skills").select(USER_COLUMNS).eq("user_id", userId).order("created_at", { ascending: true });
  if (!full.error) return (full.data ?? []) as UserSkillRow[];
  // Before migration 0065 the new columns don't exist yet.
  const basic = await supabaseAdmin.from("user_skills").select("id, name, description, instructions, icon, enabled").eq("user_id", userId).order("created_at", { ascending: true });
  if (basic.error) return []; // before migration 0036
  return (basic.data ?? []) as UserSkillRow[];
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
    ...own.map((s) => ({
      id: `${USER_PREFIX}${s.id}`,
      source: "user" as const,
      name: s.name,
      description: s.description,
      icon: s.icon || "✨",
      category: "My skills" as const,
      // Only a published skill can be used; drafts are tested in the Skill Builder, disabled ones are off.
      enabled: s.enabled && (s.status ?? "published") === "published",
      capabilities: s.capabilities ?? null,
      status: (s.status ?? "published") as Skill["status"],
      version: s.version ?? 1,
    })),
  ];
}

/** Read at the start of every tool-capable chat turn — cached briefly, invalidated on every edit. */
export const listSkills = memoAsync(30_000, listSkillsUncached, (userId) => userId);

export async function getSkill(userId: string, id: string): Promise<Skill & { instructions: string }> {
  const builtin = builtinSkill(id);
  if (builtin) return { id: builtin.id, source: "builtin", name: builtin.name, description: builtin.description, icon: builtin.icon, category: builtin.category, enabled: true, instructions: builtin.instructions };
  if (id.startsWith(USER_PREFIX)) {
    const { data } = await supabaseAdmin.from("user_skills").select(USER_COLUMNS).eq("user_id", userId).eq("id", id.slice(USER_PREFIX.length)).maybeSingle();
    if (data) {
      const status = ((data.status as string) ?? "published") as Skill["status"];
      return { id, source: "user", name: data.name as string, description: data.description as string, icon: (data.icon as string) || "✨", category: "My skills", enabled: Boolean(data.enabled) && status === "published", instructions: data.instructions as string, capabilities: (data.capabilities as string[] | null) ?? null, status, version: Number(data.version ?? 1) };
    }
  }
  // Models sometimes pass the skill's name instead of its id.
  const byName = (await listSkills(userId)).find((s) => s.name.toLowerCase() === id.trim().toLowerCase());
  if (byName && byName.id !== id) return getSkill(userId, byName.id);
  throw new HttpError(404, "No such skill");
}

export type SkillInput = { name: string; description?: string; instructions: string; icon?: string; enabled?: boolean; capabilities?: Capability[] | null };

export async function createSkill(userId: string, input: SkillInput) {
  const allowed = (await entitlementsFor(userId)).customSkills;
  const { count } = await supabaseAdmin.from("user_skills").select("id", { count: "exact", head: true }).eq("user_id", userId);
  if ((count ?? 0) >= allowed) throw new HttpError(403, allowed > 0 ? `Your plan includes up to ${allowed} custom skills — delete one or upgrade for more.` : "Custom skills aren't included in your plan — upgrade to create them.");
  const { data, error } = await supabaseAdmin
    .from("user_skills")
    .insert({ user_id: userId, name: input.name, description: input.description ?? "", instructions: input.instructions, icon: input.icon || "✨", enabled: input.enabled ?? true, capabilities: input.capabilities ?? null, version: 1, status: "published" })
    .select("id")
    .single();
  if (error || !data) throw new HttpError(400, error?.message ?? "Couldn't save the skill");
  await supabaseAdmin.from("skill_versions").insert({ skill_id: data.id, version: 1, manifest: { name: input.name, description: input.description ?? "", instructions: input.instructions, icon: input.icon || "✨", capabilities: input.capabilities ?? null, evals: [] }, changelog: "Initial version", created_by: userId });
  listSkills.invalidate(userId);
  return getSkill(userId, `${USER_PREFIX}${data.id}`);
}

export async function updateSkill(userId: string, id: string, input: Partial<SkillInput>) {
  if (!id.startsWith(USER_PREFIX)) throw new HttpError(400, "Built-in skills can only be switched on or off");
  // Content changes publish a new version (history kept); only switching on/off doesn't.
  const contentChange = (["name", "description", "instructions", "icon", "capabilities"] as const).some((k) => input[k] !== undefined);
  if (contentChange) {
    const current = await getSkill(userId, id);
    const manifest = manifestSchema.parse({ name: input.name ?? current.name, description: input.description ?? current.description, instructions: input.instructions ?? current.instructions, icon: input.icon ?? current.icon, capabilities: input.capabilities !== undefined ? input.capabilities : (current.capabilities ?? null), evals: (await skillRow(userId, id)).evals ?? [] });
    await publishManifest(userId, id, manifest, "Edited");
  }
  if (input.enabled !== undefined) {
    const { error } = await supabaseAdmin.from("user_skills").update({ enabled: input.enabled, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("id", id.slice(USER_PREFIX.length));
    if (error) throw new HttpError(400, error.message);
  }
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

// ── Power Skills: drafts, versions, evals, publish, rollback (supabase 0065, manifest.ts) ──────────

type SkillRow = { id: string; status: string; version: number; evals: EvalCase[]; draft: SkillManifest | null; name: string; description: string; instructions: string; icon: string; capabilities: string[] | null };

async function skillRow(userId: string, id: string): Promise<SkillRow> {
  if (!id.startsWith(USER_PREFIX)) throw new HttpError(400, "Built-in skills can't be edited");
  const { data } = await supabaseAdmin.from("user_skills").select("id, status, version, evals, draft, name, description, instructions, icon, capabilities").eq("user_id", userId).eq("id", id.slice(USER_PREFIX.length)).maybeSingle();
  if (!data) throw new HttpError(404, "No such skill");
  return { ...(data as unknown as SkillRow), evals: ((data.evals as EvalCase[]) ?? []), version: Number(data.version ?? 1) };
}

function currentManifest(r: SkillRow): SkillManifest {
  return manifestSchema.parse({ name: r.name, description: r.description, instructions: r.instructions, icon: r.icon, capabilities: r.capabilities, evals: r.evals });
}

/** Validates a manifest; schema errors throw 400, lint issues come back as warnings (blocking ones throw). */
export function validateManifest(raw: unknown): { manifest: SkillManifest; warnings: string[] } {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `Check the skill: ${parsed.error.issues.map((i) => `${i.path.join(".") || "skill"} — ${i.message}`).join("; ")}`);
  const warnings = lintManifest(parsed.data);
  const blocking = warnings.filter((w) => /override Friday|contain a secret/.test(w));
  if (blocking.length) throw new HttpError(400, blocking.join(" "));
  return { manifest: parsed.data, warnings };
}

/** Saves work in progress without changing what's live. A new skill starts as a draft. */
export async function saveDraft(userId: string, id: string | null, raw: unknown) {
  const { manifest, warnings } = validateManifest(raw);
  if (!id) {
    const allowed = (await entitlementsFor(userId)).customSkills;
    const { count } = await supabaseAdmin.from("user_skills").select("id", { count: "exact", head: true }).eq("user_id", userId);
    if ((count ?? 0) >= allowed) throw new HttpError(403, allowed > 0 ? `Your plan includes up to ${allowed} custom skills — delete one or upgrade for more.` : "Custom skills aren't included in your plan — upgrade to create them.");
    const { data, error } = await supabaseAdmin
      .from("user_skills")
      .insert({ user_id: userId, name: manifest.name, description: manifest.description, instructions: manifest.instructions, icon: manifest.icon, capabilities: manifest.capabilities, evals: manifest.evals, status: "draft", version: 0, draft: manifest, enabled: true })
      .select("id")
      .single();
    if (error || !data) throw new HttpError(400, error?.message ?? "Couldn't save the draft");
    listSkills.invalidate(userId);
    return { id: `${USER_PREFIX}${data.id}`, warnings };
  }
  await skillRow(userId, id);
  const { error } = await supabaseAdmin.from("user_skills").update({ draft: manifest, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("id", id.slice(USER_PREFIX.length));
  if (error) throw new HttpError(400, error.message);
  return { id, warnings };
}

export async function skillDetail(userId: string, id: string) {
  const row = await skillRow(userId, id);
  const working = row.draft ?? currentManifest(row);
  const [versions, lastRun] = await Promise.all([
    supabaseAdmin.from("skill_versions").select("version, changelog, created_at, manifest").eq("skill_id", row.id).order("version", { ascending: false }).limit(50),
    supabaseAdmin.from("skill_eval_runs").select("passed, total, results, created_at, manifest_hash").eq("skill_id", row.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const run = lastRun.data && lastRun.data.manifest_hash === manifestHash(working) ? lastRun.data : null;
  return {
    id,
    status: row.status,
    version: row.version,
    live: row.version > 0 ? currentManifest(row) : null,
    draft: row.draft,
    working,
    warnings: lintManifest(working),
    versions: (versions.data ?? []).map((v) => ({ version: v.version as number, changelog: v.changelog as string, createdAt: v.created_at as string, capabilities: ((v.manifest as SkillManifest).capabilities ?? null) as string[] | null })),
    lastEval: run ? { passed: run.passed as number, total: run.total as number, results: run.results as EvalResult[], at: run.created_at as string } : null,
  };
}

async function publishManifest(userId: string, id: string, manifest: SkillManifest, changelog: string) {
  const row = await skillRow(userId, id);
  const version = row.version + 1;
  const { error: vErr } = await supabaseAdmin.from("skill_versions").insert({ skill_id: row.id, version, manifest, changelog: changelog.slice(0, 500), created_by: userId });
  if (vErr) throw new HttpError(409, vErr.message.includes("duplicate") ? "Someone published this skill at the same time — reload and try again." : vErr.message);
  const { error } = await supabaseAdmin
    .from("user_skills")
    .update({ name: manifest.name, description: manifest.description, instructions: manifest.instructions, icon: manifest.icon, capabilities: manifest.capabilities, evals: manifest.evals, version, status: "published", draft: null, changelog: changelog.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", row.id)
    .eq("version", row.version);
  if (error) throw new HttpError(500, error.message);
  listSkills.invalidate(userId);
  return version;
}

/**
 * Publishes the draft as the next version. Quality gate: a skill with eval cases publishes only
 * after its latest test run of exactly this draft passed every case.
 */
export async function publishDraft(userId: string, id: string, changelog: string) {
  const row = await skillRow(userId, id);
  const manifest = validateManifest(row.draft ?? currentManifest(row)).manifest;
  if (manifest.evals.length) {
    const { data: run } = await supabaseAdmin.from("skill_eval_runs").select("passed, total, manifest_hash").eq("skill_id", row.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!run || run.manifest_hash !== manifestHash(manifest)) throw new HttpError(409, "Run the tests on this draft before publishing.");
    if (run.passed !== run.total) throw new HttpError(409, `${run.total - run.passed} of ${run.total} tests failed — fix the skill or the tests first.`);
  }
  return { version: await publishManifest(userId, id, manifest, changelog || "Published") };
}

/** Rolls back by publishing an earlier version's manifest as a NEW version (nothing is erased). */
export async function rollbackSkill(userId: string, id: string, version: number) {
  const row = await skillRow(userId, id);
  const { data } = await supabaseAdmin.from("skill_versions").select("manifest").eq("skill_id", row.id).eq("version", version).maybeSingle();
  if (!data) throw new HttpError(404, "No such version");
  return { version: await publishManifest(userId, id, manifestSchema.parse(data.manifest), `Rolled back to v${version}`) };
}

export async function setSkillStatus(userId: string, id: string, status: "published" | "disabled") {
  const row = await skillRow(userId, id);
  if (status === "published" && row.version < 1) throw new HttpError(409, "Publish the draft first.");
  const { error } = await supabaseAdmin.from("user_skills").update({ status, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("id", row.id);
  if (error) throw new HttpError(500, error.message);
  listSkills.invalidate(userId);
}

export type EvalRunner = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** Runs the draft's eval cases (each one model call with the skill active, no tools) and records the result. */
export async function runSkillEvals(userId: string, id: string, run: EvalRunner) {
  const row = await skillRow(userId, id);
  const manifest = row.draft ?? currentManifest(row);
  if (!manifest.evals.length) throw new HttpError(400, "Add at least one test case first.");
  const results: EvalResult[] = [];
  for (const c of manifest.evals) {
    let answer = "";
    try {
      answer = await run(activeSkillPrompt(manifest), c.prompt);
    } catch (err) {
      results.push({ name: c.name, passed: false, failures: [`the model call failed: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`], excerpt: "" });
      continue;
    }
    results.push(checkEval(c, answer));
  }
  const passed = results.filter((r) => r.passed).length;
  await supabaseAdmin.from("skill_eval_runs").insert({ skill_id: row.id, manifest_hash: manifestHash(manifest), passed, total: results.length, results });
  return { passed, total: results.length, results };
}
