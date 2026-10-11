import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../utils/logger.js";
import { memoAsync } from "../../utils/ttlMemo.js";
import { ENTERPRISE_MIN_SEATS, ENTERPRISE_TOKENS_PER_SEAT, PLAN_LIMITS, type Plan } from "./tierConfig.js";

/**
 * The plan catalog: what each plan costs, what the Plans page says about it, its token limits and
 * its ENTITLEMENTS (which features it unlocks and how much of each). The Team Console edits it
 * (plan_catalog table, migration 0033); the code below is only the safe default a missing row or
 * column falls back to, so billing and limits keep working before the migration is applied.
 */

export type CatalogPlanId = Plan | "enterprise";

// ── Entitlements ─────────────────────────────────────────────────────────────

export const ENTITLEMENT_DEFS = [
  { key: "buildMode", label: "Build Mode", type: "boolean", hint: "Coding agent with a live sandbox" },
  { key: "fridayX", label: "FridayX (CLI + IDE)", type: "boolean", hint: "Terminal and editor coding agent; uses the same credits" },
  { key: "buildMaxRounds", label: "Build rounds per run", type: "number", hint: "How long one build can work before stopping" },
  { key: "deepResearchPerDay", label: "Deep Research per day", type: "number", hint: "0 turns it off" },
  { key: "documentsPerDay", label: "Documents per day", type: "number", hint: "Generated PPTX, XLSX, DOCX, PDF…" },
  { key: "imagesPerDay", label: "Generated images per day", type: "number", hint: "0 turns it off" },
  { key: "customSkills", label: "Custom skills", type: "number", hint: "Skills the user can create" },
  { key: "libraryStorageMb", label: "Library storage (MB)", type: "number", hint: "Files, images and documents kept" },
  { key: "teamUpModels", label: "Team Up models", type: "number", hint: "Most models in one Team Up panel" },
  { key: "mcpServers", label: "MCP servers", type: "number", hint: "Custom tool servers" },
  { key: "automations", label: "Automations", type: "number", hint: "Scheduled tasks" },
  { key: "prioritySupport", label: "Priority support", type: "boolean", hint: "Tickets jump the queue" },
] as const;

export type EntitlementKey = (typeof ENTITLEMENT_DEFS)[number]["key"];
export type Entitlements = {
  buildMode: boolean;
  fridayX: boolean;
  buildMaxRounds: number;
  deepResearchPerDay: number;
  documentsPerDay: number;
  imagesPerDay: number;
  customSkills: number;
  libraryStorageMb: number;
  teamUpModels: number;
  mcpServers: number;
  automations: number;
  prioritySupport: boolean;
};

export const DEFAULT_ENTITLEMENTS: Record<CatalogPlanId, Entitlements> = {
  free: { buildMode: true, fridayX: true, buildMaxRounds: 30, deepResearchPerDay: 3, documentsPerDay: 5, imagesPerDay: 3, customSkills: 3, libraryStorageMb: 500, teamUpModels: 3, mcpServers: 2, automations: 3, prioritySupport: false },
  pro: { buildMode: true, fridayX: true, buildMaxRounds: 100, deepResearchPerDay: 40, documentsPerDay: 100, imagesPerDay: 50, customSkills: 25, libraryStorageMb: 10_240, teamUpModels: 5, mcpServers: 10, automations: 20, prioritySupport: false },
  premium: { buildMode: true, fridayX: true, buildMaxRounds: 150, deepResearchPerDay: 150, documentsPerDay: 300, imagesPerDay: 150, customSkills: 100, libraryStorageMb: 51_200, teamUpModels: 8, mcpServers: 25, automations: 50, prioritySupport: true },
  enterprise: { buildMode: true, fridayX: true, buildMaxRounds: 150, deepResearchPerDay: 300, documentsPerDay: 500, imagesPerDay: 300, customSkills: 200, libraryStorageMb: 102_400, teamUpModels: 8, mcpServers: 25, automations: 50, prioritySupport: true },
};

/**
 * Keeps only known keys with the right type, clamped to sane ranges — entitlement JSON is written by
 * admins and must never be able to break a request (a string where a number belongs, a negative
 * round count…). Unknown keys are dropped.
 */
export function sanitizeEntitlements(raw: unknown): Partial<Entitlements> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, boolean | number> = {};
  for (const def of ENTITLEMENT_DEFS) {
    const value = (raw as Record<string, unknown>)[def.key];
    if (def.type === "boolean" && typeof value === "boolean") out[def.key] = value;
    if (def.type === "number" && typeof value === "number" && Number.isFinite(value)) out[def.key] = Math.max(0, Math.min(1_000_000, Math.round(value)));
  }
  return out as Partial<Entitlements>;
}

/** Later layers win: plan defaults ← catalog ← organization ← personal package/grant. */
export function mergeEntitlements(base: Entitlements, ...layers: Array<Partial<Entitlements> | null | undefined>): Entitlements {
  return Object.assign({}, base, ...layers.map((l) => sanitizeEntitlements(l)));
}

// ── Catalog ──────────────────────────────────────────────────────────────────

export type CatalogPlan = {
  id: CatalogPlanId;
  name: string;
  tagline: string;
  /** Per month (per seat per month for enterprise). */
  monthlyPricePaise: number;
  annualDiscountPercent: number;
  minSeats: number | null;
  features: string[];
  badge: string | null;
  highlight: boolean;
  limits: { weekly: number; rolling: number; monthly: number | null; tokensPerSeat: number | null };
  entitlements: Entitlements;
  active: boolean;
  sortOrder: number;
};

const DEFAULT_CATALOG: CatalogPlan[] = [
  { id: "free", name: "Free", tagline: "Everything you need to get started.", monthlyPricePaise: 0, features: ["Light daily usage, refreshed every 5 hours and weekly", "Chat, search, Canvas and images", "Build Mode trial projects"], highlight: false },
  { id: "pro", name: "Pro", tagline: "For daily work, research and building.", monthlyPricePaise: 99_900, features: ["Everything in Free", "Generous usage every 5 hours, week and month", "Flagship models", "Full Build Mode with GitHub PRs", "Deep Research, documents and skills"], highlight: true },
  { id: "premium", name: "Premium", tagline: "The most capable Friday for power users.", monthlyPricePaise: 199_900, features: ["Everything in Pro", "About 2x Pro's usage, the most for one person", "Reasoning and heavy models", "Longest Build Mode runs", "Largest Team Up panels and Library"], highlight: false },
  { id: "enterprise", name: "Enterprise", tagline: "Pooled usage, admin controls and priority support for teams.", monthlyPricePaise: 249_900, features: ["Org-pooled monthly usage, no 5-hour lockout", "Per-member caps set by your admins", "Every model, priority handling", "Centralized billing", "Priority support"], highlight: false },
].map((p, i) => ({
  ...p,
  id: p.id as CatalogPlanId,
  annualDiscountPercent: 10,
  minSeats: p.id === "enterprise" ? ENTERPRISE_MIN_SEATS : null,
  badge: null,
  limits: defaultLimits(p.id as CatalogPlanId),
  entitlements: DEFAULT_ENTITLEMENTS[p.id as CatalogPlanId],
  active: true,
  sortOrder: i,
}));

function defaultLimits(id: CatalogPlanId): CatalogPlan["limits"] {
  if (id === "enterprise") return { weekly: 0, rolling: 0, monthly: null, tokensPerSeat: ENTERPRISE_TOKENS_PER_SEAT };
  const base = PLAN_LIMITS[id];
  return { weekly: base.weeklyTokens, rolling: base.rollingWindowTokens, monthly: base.monthlyTokens, tokensPerSeat: null };
}

type CatalogRow = {
  id: CatalogPlanId;
  name: string;
  tagline: string;
  monthly_price_paise: number;
  annual_discount_percent: number;
  min_seats: number | null;
  features: string[];
  badge: string | null;
  highlight: boolean;
  weekly_tokens: number | null;
  rolling_tokens: number | null;
  monthly_tokens: number | null;
  tokens_per_seat: number | null;
  entitlements: unknown;
  active: boolean;
  sort_order: number;
};

export function planFromRow(row: CatalogRow): CatalogPlan {
  const fallback = DEFAULT_CATALOG.find((p) => p.id === row.id)!;
  return {
    id: row.id,
    name: row.name || fallback.name,
    tagline: row.tagline ?? fallback.tagline,
    monthlyPricePaise: Number(row.monthly_price_paise ?? fallback.monthlyPricePaise),
    annualDiscountPercent: row.annual_discount_percent ?? 10,
    minSeats: row.id === "enterprise" ? Math.max(1, row.min_seats ?? ENTERPRISE_MIN_SEATS) : null,
    features: row.features?.length ? row.features : fallback.features,
    badge: row.badge || null,
    highlight: Boolean(row.highlight),
    limits: {
      weekly: Number(row.weekly_tokens ?? fallback.limits.weekly),
      rolling: Number(row.rolling_tokens ?? fallback.limits.rolling),
      // Free has no monthly ceiling by default; an admin may add one.
      monthly: row.monthly_tokens != null ? Number(row.monthly_tokens) : fallback.limits.monthly,
      tokensPerSeat: row.id === "enterprise" ? Number(row.tokens_per_seat ?? ENTERPRISE_TOKENS_PER_SEAT) : null,
    },
    entitlements: mergeEntitlements(DEFAULT_ENTITLEMENTS[row.id], row.entitlements as Partial<Entitlements>),
    active: row.active !== false,
    sortOrder: row.sort_order ?? fallback.sortOrder,
  };
}

async function loadCatalog(): Promise<CatalogPlan[]> {
  const { data, error } = await supabaseAdmin.from("plan_catalog").select("*");
  if (error) {
    // Migration 0033 not applied yet (or a transient failure) — the code defaults are always valid.
    logger.warn("plan_catalog_load_failed", { error: error.message });
    return DEFAULT_CATALOG;
  }
  const rows = new Map((data as CatalogRow[] | null ?? []).map((r) => [r.id, planFromRow(r)]));
  return DEFAULT_CATALOG.map((p) => rows.get(p.id) ?? p).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Read on every quota check and billing call — cached a minute, invalidated on every console edit. */
export const getPlanCatalog = memoAsync(60_000, loadCatalog, () => "catalog");

export async function getCatalogPlan(id: CatalogPlanId): Promise<CatalogPlan> {
  const catalog = await getPlanCatalog().catch(() => DEFAULT_CATALOG);
  return catalog.find((p) => p.id === id) ?? DEFAULT_CATALOG.find((p) => p.id === id)!;
}

/** Token limits for an individual plan, as the quota system reads them. */
export async function planLimitsFor(plan: Plan): Promise<{ rolling: number; weekly: number; monthly: number | null }> {
  const { limits } = await getCatalogPlan(plan);
  return { rolling: limits.rolling, weekly: limits.weekly, monthly: limits.monthly };
}

export function annualPricePaise(plan: Pick<CatalogPlan, "monthlyPricePaise" | "annualDiscountPercent">): number {
  return Math.round(plan.monthlyPricePaise * 12 * (1 - plan.annualDiscountPercent / 100));
}

export type CatalogInput = Partial<{
  name: string;
  tagline: string;
  monthlyPricePaise: number;
  annualDiscountPercent: number;
  minSeats: number | null;
  features: string[];
  badge: string | null;
  highlight: boolean;
  weeklyTokens: number | null;
  rollingTokens: number | null;
  monthlyTokens: number | null;
  tokensPerSeat: number | null;
  entitlements: Partial<Entitlements>;
  active: boolean;
  sortOrder: number;
}>;

export async function saveCatalogPlan(id: CatalogPlanId, input: CatalogInput, actorId: string): Promise<CatalogPlan> {
  const row: Record<string, unknown> = { id, updated_by: actorId, updated_at: new Date().toISOString() };
  const map: Record<string, string> = {
    name: "name", tagline: "tagline", monthlyPricePaise: "monthly_price_paise", annualDiscountPercent: "annual_discount_percent",
    minSeats: "min_seats", features: "features", badge: "badge", highlight: "highlight", weeklyTokens: "weekly_tokens",
    rollingTokens: "rolling_tokens", monthlyTokens: "monthly_tokens", tokensPerSeat: "tokens_per_seat", active: "active", sortOrder: "sort_order",
  };
  for (const [key, column] of Object.entries(map)) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) row[column] = value;
  }
  if (input.entitlements !== undefined) row.entitlements = sanitizeEntitlements(input.entitlements);
  const current = await getCatalogPlan(id);
  if (row.name === undefined) row.name = current.name;
  const { data, error } = await supabaseAdmin.from("plan_catalog").upsert(row, { onConflict: "id" }).select().single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't save the plan");
  getPlanCatalog.invalidate("catalog");
  return planFromRow(data as CatalogRow);
}
