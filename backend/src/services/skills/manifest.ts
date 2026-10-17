import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Power Skill manifests (brief §37). A skill is DECLARATIVE: instructions + the capabilities it may
 * use + eval cases. It never carries code, and asking for a tool in its text grants nothing — the
 * tool loop only lets an active user skill call tools in its declared capability groups
 * (allowedToolsFor). First-party built-in skills are trusted and unrestricted.
 */

/** Capability groups → the real tools they unlock, with how risky they are (shown when a user grants them). */
export const CAPABILITIES = {
  web: { label: "Search and read the web", risk: "low", tools: ["web_search", "fetch_url", "research_in_parallel"] },
  documents: { label: "Create and edit documents and pages", risk: "low", tools: ["create_document", "create_page", "read_page", "update_page"] },
  project_files: { label: "Search your project's files", risk: "low", tools: ["search_project_files"] },
  code: { label: "Run code in a sandbox (incl. the skill's own scripts)", risk: "medium", tools: ["run_code", "run_skill_script"] },
  images: { label: "Generate and edit images (uses your image allowance)", risk: "medium", tools: ["generate_image"] },
  memory: { label: "Remember or forget things about you", risk: "medium", tools: ["remember", "forget"] },
  browser: { label: "Drive a web browser", risk: "high", tools: ["browser"] },
  connected_apps: {
    label: "Read your connected apps (Gmail, Drive, Calendar, GitHub, Notion…)",
    risk: "high",
    tools: ["gmail_search", "gmail_read", "drive_search", "drive_read", "calendar_events", "github_list_repos", "github_read_file", "github_search_code", "github_list_issues", "github_read_issue", "notion_search", "notion_read_page", "vercel_deployments", "railway_projects", "supabase_query", "razorpay_payments"],
  },
} as const;
export type Capability = keyof typeof CAPABILITIES;
export const CAPABILITY_IDS = Object.keys(CAPABILITIES) as Capability[];
/** What a user skill gets when it declares nothing (skills made before manifests). */
export const DEFAULT_CAPABILITIES: Capability[] = ["web", "documents"];
/** Always allowed: loading another skill's playbook is just text. */
const ALWAYS = ["use_skill"];

export function allowedToolsFor(capabilities: readonly string[] | null | undefined): Set<string> {
  const caps = (capabilities ?? DEFAULT_CAPABILITIES).filter((c): c is Capability => c in CAPABILITIES);
  return new Set([...ALWAYS, ...caps.flatMap((c) => CAPABILITIES[c].tools)]);
}

const evalCase = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(3).max(2000),
  mustInclude: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  mustNotInclude: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  maxChars: z.number().int().min(50).max(20000).optional(),
});
export type EvalCase = z.infer<typeof evalCase>;

/** A script the skill can run with run_skill_script — only ever inside the isolated code sandbox. */
const script = z.object({
  name: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "lower-case letters, numbers, - and _"),
  language: z.enum(["python", "javascript"]),
  description: z.string().trim().max(200).default(""),
  code: z.string().min(1).max(20_000),
});
export type SkillScript = z.infer<typeof script>;

export const manifestSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(300).default(""),
    instructions: z.string().trim().min(20).max(12000),
    icon: z.string().trim().max(8).default("✨"),
    capabilities: z.array(z.enum(CAPABILITY_IDS as [Capability, ...Capability[]])).max(CAPABILITY_IDS.length).nullable().default(null),
    evals: z.array(evalCase).max(20).default([]),
    scripts: z.array(script).max(5).default([]),
  })
  .refine((m) => m.scripts.length === 0 || (m.capabilities ?? DEFAULT_CAPABILITIES).includes("code"), {
    message: "A skill with scripts must declare the “Run code” capability",
    path: ["capabilities"],
  })
  .refine((m) => new Set(m.scripts.map((s) => s.name)).size === m.scripts.length, { message: "Two scripts have the same name", path: ["scripts"] });
export type SkillManifest = z.infer<typeof manifestSchema>;

/** Lint beyond the schema: things that make a skill unsafe or useless. Empty = fine. */
export function lintManifest(m: SkillManifest): string[] {
  const issues: string[] = [];
  const caps = new Set(m.capabilities ?? DEFAULT_CAPABILITIES);
  if (/\b(ignore|disregard|override)\b.{0,40}\b(previous|system|above|prior)\b.{0,20}\b(instructions?|prompts?|rules?)\b/i.test(m.instructions)) {
    issues.push("The instructions try to override Friday's own rules — remove that part.");
  }
  if (/\b(api[_ -]?key|password|secret|token)\s*[:=]\s*\S{8,}/i.test(m.instructions)) issues.push("The instructions look like they contain a secret — never put keys or passwords in a skill.");
  const mentions = (re: RegExp) => re.test(m.instructions);
  if (mentions(/\b(run_code|run (the )?code|python script)\b/i) && !caps.has("code")) issues.push("The instructions run code but the skill doesn't declare the “Run code” capability — it will be refused.");
  if (mentions(/\b(gmail|google drive|calendar|github|notion)\b/i) && !caps.has("connected_apps")) issues.push("The instructions use connected apps but the skill doesn't declare that capability — it will be refused.");
  if (mentions(/\b(generate|draw|create) (an? )?(image|picture|logo)\b/i) && !caps.has("images")) issues.push("The instructions make images but the skill doesn't declare the image capability — it will be refused.");
  if (new Set(m.evals.map((e) => e.name)).size !== m.evals.length) issues.push("Two eval cases have the same name.");
  return issues;
}

export function manifestHash(m: SkillManifest): string {
  return createHash("sha256").update(JSON.stringify({ n: m.name, d: m.description, i: m.instructions, c: m.capabilities, e: m.evals, s: m.scripts })).digest("hex").slice(0, 32);
}

export type EvalResult = { name: string; passed: boolean; failures: string[]; excerpt: string };

/** Deterministic checks of one answer against a case (the model call happens in skillService). */
export function checkEval(c: EvalCase, answer: string): EvalResult {
  const failures: string[] = [];
  const low = answer.toLowerCase();
  for (const s of c.mustInclude) if (!low.includes(s.toLowerCase())) failures.push(`missing “${s}”`);
  for (const s of c.mustNotInclude) if (low.includes(s.toLowerCase())) failures.push(`contains “${s}”`);
  if (c.maxChars != null && answer.length > c.maxChars) failures.push(`too long (${answer.length} > ${c.maxChars} characters)`);
  if (!answer.trim()) failures.push("empty answer");
  return { name: c.name, passed: failures.length === 0, failures, excerpt: answer.slice(0, 400) };
}
