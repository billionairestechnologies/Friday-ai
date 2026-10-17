import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../utils/logger.js";
import { invalidateMemoized, memoAsync } from "../../utils/ttlMemo.js";
import { ENTERPRISE_MIN_SEATS, ENTERPRISE_TOKENS_PER_SEAT, PLAN_ALLOWANCES, type Plan } from "./tierConfig.js";

/**
 * The plan catalog: what each plan costs, what the Plans page says about it, its monthly token allowance and
 * its ENTITLEMENTS (which features it unlocks and how much of each). The Team Console edits it
 * (plan_catalog table, migration 0033); the code below is only the safe default a missing row or
 * column falls back to, so billing and limits keep working before the migration is applied.
 */

export type CatalogPlanId = Plan | "enterprise";

// ── Entitlements ─────────────────────────────────────────────────────────────

export const ENTITLEMENT_DEFS = [
  { key: "buildMode", label: "Build Mode", type: "boolean", hint: "Coding agent with a live sandbox" },
  { key: "fridayX", label: "FridayX (CLI + IDE)", type: "boolean", hint: "Terminal and editor coding agent; uses the same monthly tokens" },
  { key: "voice", label: "Voice", type: "boolean", hint: "Talk in chat" },
  { key: "canvas", label: "Canvas", type: "boolean", hint: "Live preview documents" },
  { key: "images", label: "Images", type: "boolean", hint: "Generate and edit images" },
  { key: "connectors", label: "Connectors", type: "number", hint: "Linked accounts. 0 turns them off" },
  { key: "buildMaxRounds", label: "Build rounds per run", type: "number", hint: "How long one build can work before stopping" },
  { key: "deepResearchPerDay", label: "Deep Research per day", type: "number", hint: "0 turns it off" },
  { key: "documentsPerDay", label: "Documents per day", type: "number", hint: "Generated PPTX, XLSX, DOCX, PDF…" },
  { key: "imagesPerDay", label: "Generated images per day", type: "number", hint: "0 turns it off" },
  { key: "customSkills", label: "Custom skills", type: "number", hint: "Skills the user can create" },
  { key: "libraryStorageMb", label: "Library storage (MB)", type: "number", hint: "Files, images and documents kept" },
  { key: "teamUpModels", label: "Team Up models", type: "number", hint: "Most models in one Team Up panel" },
  { key: "mcpServers", label: "MCP servers", type: "number", hint: "Custom tool servers" },
  { key: "automations", label: "Automations", type: "number", hint: "Scheduled tasks. 0 turns them off" },
  { key: "prioritySupport", label: "Priority support", type: "boolean", hint: "Tickets jump the queue" },
  { key: "maxDevices", label: "Signed-in devices", type: "number", hint: "Web/phone sessions at once; a new sign-in over the limit signs out the oldest. 0 = no limit" },
] as const;

export type EntitlementKey = (typeof ENTITLEMENT_DEFS)[number]["key"];
export type Entitlements = {
  buildMode: boolean;
  fridayX: boolean;
  voice: boolean;
  canvas: boolean;
  images: boolean;
  connectors: number;
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
  /** 0 = no limit (supabase 0068). */
  maxDevices: number;
};

export const DEFAULT_ENTITLEMENTS: Record<CatalogPlanId, Entitlements> = {
  free: { buildMode: true, fridayX: true, voice: true, canvas: true, images: true, connectors: 3, buildMaxRounds: 30, deepResearchPerDay: 3, imagesPerDay: 3, documentsPerDay: 5, customSkills: 3, libraryStorageMb: 500, teamUpModels: 3, mcpServers: 2, automations: 3, prioritySupport: false, maxDevices: 0 },
  pro: { buildMode: true, fridayX: true, voice: true, canvas: true, images: true, connectors: 15, buildMaxRounds: 100, deepResearchPerDay: 40, imagesPerDay: 50, documentsPerDay: 100, customSkills: 25, libraryStorageMb: 10_240, teamUpModels: 5, mcpServers: 10, automations: 20, prioritySupport: false, maxDevices: 0 },
  premium: { buildMode: true, fridayX: true, voice: true, canvas: true, images: true, connectors: 40, buildMaxRounds: 150, deepResearchPerDay: 150, imagesPerDay: 150, documentsPerDay: 300, customSkills: 100, libraryStorageMb: 51_200, teamUpModels: 8, mcpServers: 25, automations: 50, prioritySupport: true, maxDevices: 0 },
  enterprise: { buildMode: true, fridayX: true, voice: true, canvas: true, images: true, connectors: 100, buildMaxRounds: 150, deepResearchPerDay: 300, imagesPerDay: 300, documentsPerDay: 500, customSkills: 200, libraryStorageMb: 102_400, teamUpModels: 8, mcpServers: 25, automations: 50, prioritySupport: true, maxDevices: 0 },
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
  /** monthly = billable tokens per subscription period (individual plans); tokensPerSeat = enterprise pool per seat. */
  limits: { monthly: number | null; tokensPerSeat: number | null };
  entitlements: Entitlements;
  active: boolean;
  sortOrder: number;
};

const DEFAULT_CATALOG: CatalogPlan[] = [
  { id: "free", name: "Free", tagline: "Everything you need to get started.", monthlyPricePaise: 0, features: ["1M tokens every month", "Chat, search, Canvas and images", "Build Mode trial projects"], highlight: false },
  { id: "pro", name: "Pro", tagline: "For daily work, research and building.", monthlyPricePaise: 99_900, features: ["Everything in Free", "10M tokens every month, use them whenever you like", "Flagship models", "Full Build Mode with GitHub PRs", "Deep Research, documents and skills"], highlight: true },
  { id: "premium", name: "Premium", tagline: "The most capable Friday for power users.", monthlyPricePaise: 199_900, features: ["Everything in Pro", "25M tokens every month, the most for one person", "Reasoning and heavy models", "Longest Build Mode runs", "Largest Team Up panels and Library"], highlight: false },
  { id: "enterprise", name: "Enterprise", tagline: "Pooled usage, admin controls and priority support for teams.", monthlyPricePaise: 249_900, features: ["30M tokens per seat each month, pooled across your team", "Per-member caps set by your admins", "Every model, priority handling", "Centralized billing", "Priority support"], highlight: false },
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
  if (id === "enterprise") return { monthly: null, tokensPerSeat: ENTERPRISE_TOKENS_PER_SEAT };
  return { monthly: PLAN_ALLOWANCES[id], tokensPerSeat: null };
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
      monthly: row.id === "enterprise" ? null : row.monthly_tokens != null ? Number(row.monthly_tokens) : fallback.limits.monthly,
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

/** Monthly allowance (billable tokens) for an individual plan, as the quota system reads it. */
export async function planAllowanceFor(plan: Plan): Promise<number> {
  const { limits } = await getCatalogPlan(plan);
  return limits.monthly ?? PLAN_ALLOWANCES[plan];
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
    minSeats: "min_seats", features: "features", badge: "badge", highlight: "highlight", monthlyTokens: "monthly_tokens", tokensPerSeat: "tokens_per_seat", active: "active", sortOrder: "sort_order",
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
  // Drop every cached entitlement too, so the next chat, build, or /usage/quota sees this save
  // immediately. A minute of TTL would leave the old plan in place after the admin clicked save.
  invalidateMemoized();
  return planFromRow(data as CatalogRow);
}
