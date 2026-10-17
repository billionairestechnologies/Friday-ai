import { parseEmiParams } from "./emi";
import { parseOffsideParams } from "./offside";
import { parseProjectileParams } from "./projectile";

/**
 * The ONLY interactive experiences Friday renders (an allow-list). A model's answer or a URL can
 * pick one and supply validated parameters — never markup or code.
 */
export type ExperienceId = "offside" | "emi" | "projectile";

export type ExperienceMeta = {
  id: ExperienceId;
  title: string;
  description: string;
  category: "Sports" | "Finance" | "Science";
  objective: string;
  parse: (raw: unknown) => Record<string, unknown> | null;
};

export const EXPERIENCES: ExperienceMeta[] = [
  {
    id: "offside",
    title: "Offside, explained",
    description: "Drag the attacker and see instantly whether they're offside — and why being offside isn't always an offence.",
    category: "Sports",
    objective: "Understand the offside position, the line it's judged against, and when it becomes an offence.",
    parse: parseOffsideParams as ExperienceMeta["parse"],
  },
  {
    id: "emi",
    title: "Loan EMI calculator",
    description: "See your monthly instalment, total interest and how each year's payments split between principal and interest.",
    category: "Finance",
    objective: "See how the rate and the tenure change what a loan really costs.",
    parse: parseEmiParams as ExperienceMeta["parse"],
  },
  {
    id: "projectile",
    title: "Projectile motion",
    description: "Launch a ball at any speed and angle — on Earth, the Moon, Mars or Jupiter — and watch the arc.",
    category: "Science",
    objective: "See why 45° goes furthest and how gravity shapes the flight.",
    parse: parseProjectileParams as ExperienceMeta["parse"],
  },
];

export const experienceById = (id: string) => EXPERIENCES.find((e) => e.id === id) ?? null;

/** A `friday-experience` block: {"experience": id, "params": {...}, "title"?: string}. */
export function parseExperienceBlock(raw: unknown): { meta: ExperienceMeta; params: Record<string, unknown>; title?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const meta = typeof r.experience === "string" ? experienceById(r.experience) : null;
  if (!meta) return null;
  const params = meta.parse(r.params);
  if (!params) return null;
  return { meta, params, ...(typeof r.title === "string" && r.title.trim() ? { title: r.title.trim().slice(0, 120) } : {}) };
}
