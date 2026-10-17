import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { logger } from "../../utils/logger.js";
import { quotaRpc } from "./tokenQuotaService.js";

/**
 * Model usage multipliers (supabase 0059): how much of a plan's allowance one model's tokens cost.
 *
 *   charged billable = ⌈base billable × multiplier⌉      (base billable = allowance.ts#billableTokens)
 *
 * Rows are append-only versions; this module resolves which one applies to a call, publishes new
 * ones (optimistic concurrency against the newest row the admin saw) and cancels scheduled ones.
 * The UsageMeter stamps the applied multiplier + row id on every ledger row, so a change never
 * rewrites past usage.
 */

export const MAX_MULTIPLIER = 100;
/** Config is re-read at most this often; publishing in this process drops it at once. Scheduled rows
 *  are already in the cached set, so they start/end exactly on time, not on the next refresh. */
const CACHE_TTL_MS = 30_000;

export type MultiplierKind = "base" | "promo";

export type MultiplierRow = {
  id: string;
  provider_slug: string;
  model_id: string;
  multiplier: number;
  kind: MultiplierKind;
  effective_from: string;
  effective_to: string | null;
  reason: string;
  created_by: string | null;
  created_at: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
};

export type AppliedMultiplier = { multiplier: number; id: string | null };

export const DEFAULT_MULTIPLIER: AppliedMultiplier = { multiplier: 1, id: null };

const t = (iso: string) => Date.parse(iso);

function applies(row: MultiplierRow, kind: MultiplierKind, at: number): boolean {
  if (row.kind !== kind || row.cancelled_at) return false;
  if (t(row.effective_from) > at) return false;
  return row.effective_to == null || at < t(row.effective_to);
}

/** Newest wins: for base rows the latest effective_from (a later scheduled change supersedes); ties and promos by creation. */
function newest(rows: MultiplierRow[], kind: MultiplierKind): MultiplierRow | null {
  let best: MultiplierRow | null = null;
  for (const r of rows) {
    if (!best) {
      best = r;
      continue;
    }
    const byFrom = kind === "base" ? t(r.effective_from) - t(best.effective_from) : 0;
    if (byFrom > 0 || (byFrom === 0 && (t(r.created_at) > t(best.created_at) || (r.created_at === best.created_at && r.id > best.id)))) best = r;
  }
  return best;
}

/**
 * The multiplier a call to `providerSlug/modelId` at `at` is charged at. Precedence:
 * exact-provider promo > any-provider ('*') promo > exact base > '*' base > 1×.
 */
export function resolveMultiplier(rows: readonly MultiplierRow[], providerSlug: string, modelId: string, at: number = Date.now()): AppliedMultiplier {
  const forModel = rows.filter((r) => r.model_id === modelId && (r.provider_slug === providerSlug || r.provider_slug === "*"));
  for (const kind of ["promo", "base"] as const) {
    for (const provider of [providerSlug, "*"]) {
      const hit = newest(forModel.filter((r) => r.provider_slug === provider && applies(r, kind, at)), kind);
      if (hit) return { multiplier: Number(hit.multiplier), id: hit.id };
    }
  }
  return DEFAULT_MULTIPLIER;
}

/** ⌈base × multiplier⌉ — never negative; 1× is exactly the base figure. */
export function applyMultiplier(baseBillable: number, multiplier: number): number {
  if (baseBillable <= 0 || multiplier <= 0) return 0;
  if (multiplier === 1) return baseBillable;
  // Round the product to 6 decimals first so 0.1 × 30 doesn't ceil 3.0000000000000004 up to 4.
  return Math.ceil(Math.round(baseBillable * multiplier * 1e6) / 1e6);
}

// ── Loading (cached) ────────────────────────────────────────────────────────────────────────────

type Loader = () => Promise<MultiplierRow[]>;
const dbLoader: Loader = async () => {
  const { data, error } = await supabaseAdmin.from("model_multipliers").select("*").is("cancelled_at", null).order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ ...r, multiplier: Number(r.multiplier) })) as MultiplierRow[];
};
let loader: Loader = dbLoader;
let cache: { at: number; rows: MultiplierRow[] } | null = null;
let inflight: Promise<MultiplierRow[]> | null = null;

/** Test hook: serve multiplier rows without a database. */
export function setMultiplierLoaderForTests(next: Loader | null) {
  loader = next ?? dbLoader;
  cache = null;
  inflight = null;
}

export function invalidateMultipliers() {
  cache = null;
}

async function activeRows(): Promise<MultiplierRow[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  inflight ??= loader()
    .then((rows) => {
      cache = { at: Date.now(), rows };
      return rows;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * The multiplier for a call happening now. If the config can't be read, the last loaded config is
 * used; with none at all the call is charged at 1× and the failure logged — the ledger itself fails
 * closed separately, so this can only mis-weight, never let usage go unrecorded.
 */
export async function multiplierFor(providerSlug: string, modelId: string, at: number = Date.now()): Promise<AppliedMultiplier> {
  try {
    return resolveMultiplier(await activeRows(), providerSlug, modelId, at);
  } catch (err) {
    logger.error("model_multiplier_load_failed", { error: err instanceof Error ? err.message : String(err) });
    return cache ? resolveMultiplier(cache.rows, providerSlug, modelId, at) : DEFAULT_MULTIPLIER;
  }
}

// ── Admin ───────────────────────────────────────────────────────────────────────────────────────

export type PublishItem = {
  provider_slug: string;
  model_id: string;
  multiplier: number;
  kind: MultiplierKind;
  effective_from?: string | null;
  effective_to?: string | null;
  reason: string;
  /** Id of the newest row for this model on the admin's screen (null = it had none). */
  expected_latest: string | null;
};

export function validatePublish(items: PublishItem[], now: number = Date.now()): void {
  if (!items.length) throw new HttpError(400, "Pick at least one model.");
  const seen = new Set<string>();
  for (const it of items) {
    const key = `${it.provider_slug}/${it.model_id}`;
    if (seen.has(key)) throw new HttpError(400, `${key} is listed twice.`);
    seen.add(key);
    if (!Number.isFinite(it.multiplier) || it.multiplier < 0 || it.multiplier > MAX_MULTIPLIER) {
      throw new HttpError(400, `Multiplier must be between 0 and ${MAX_MULTIPLIER}.`);
    }
    if (Math.round(it.multiplier * 10_000) !== it.multiplier * 10_000) throw new HttpError(400, "Use at most 4 decimal places.");
    const from = it.effective_from ? t(it.effective_from) : now;
    if (Number.isNaN(from)) throw new HttpError(400, "Invalid start time.");
    // A minute of slack for clock skew between the admin's browser and the server.
    if (from < now - 60_000) throw new HttpError(400, "Changes can't be backdated — past usage keeps the multiplier it was charged at.");
    if (it.kind === "promo") {
      if (!it.effective_to) throw new HttpError(400, "A promotion needs an end time.");
      if (Number.isNaN(t(it.effective_to)) || t(it.effective_to) <= Math.max(from, now)) throw new HttpError(400, "The promotion must end after it starts.");
    } else if (it.effective_to) {
      throw new HttpError(400, "A standing multiplier has no end time — use a promotion for a temporary change.");
    }
    if (it.reason.trim().length < 3) throw new HttpError(400, "Say why (at least a few words) — it goes in the audit log.");
  }
}

function rpcError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("stale_multiplier")) {
    throw new HttpError(409, "Someone changed this model's multiplier while you were editing. Reload to see the latest, then try again.");
  }
  if (message.includes("active_base_multiplier")) throw new HttpError(409, "That multiplier is already in effect — publish a new value instead.");
  if (message.includes("promo_already_ended")) throw new HttpError(409, "That promotion has already ended.");
  if (message.includes("not found")) throw new HttpError(404, "Multiplier not found.");
  throw err instanceof Error ? err : new Error(message);
}

export async function publishMultipliers(items: PublishItem[], actorId: string): Promise<MultiplierRow[]> {
  validatePublish(items);
  const rows = items.map((it) => ({ ...it, reason: it.reason.trim(), effective_from: it.effective_from ?? null, effective_to: it.effective_to ?? null }));
  try {
    const created = await quotaRpc<MultiplierRow[]>("model_multiplier_publish", { p_rows: rows, p_actor: actorId });
    return Array.isArray(created) ? created : [created];
  } catch (err) {
    rpcError(err);
  } finally {
    invalidateMultipliers();
  }
}

export async function cancelMultiplier(id: string, actorId: string): Promise<MultiplierRow> {
  try {
    return await quotaRpc<MultiplierRow>("model_multiplier_cancel", { p_id: id, p_actor: actorId });
  } catch (err) {
    rpcError(err);
  } finally {
    invalidateMultipliers();
  }
}

export type ModelUsage = { provider_slug: string; model_id: string; calls: number; users: number; base_billable: number; billable: number; cost_usd: number };

export type MultiplierModel = {
  provider_slug: string;
  model_id: string;
  display_name: string;
  enabled: boolean;
  min_tier: string | null;
  current: AppliedMultiplier & { kind: MultiplierKind | null; until: string | null };
  /** Starts in the future, not cancelled. */
  scheduled: MultiplierRow[];
  /** Newest row id for the optimistic-concurrency check. */
  latest_id: string | null;
  usage30d: ModelUsage | null;
};

/** Everything Console → Models → Usage multipliers shows: each known model, what applies now, what's scheduled, 30-day usage. */
export async function multiplierOverview(now: number = Date.now()) {
  const since = new Date(now - 30 * 86_400_000).toISOString();
  const [models, history, usage] = await Promise.all([
    supabaseAdmin.from("provider_models").select("model_id, display_name, is_enabled_for_users, min_tier, providers(slug)").order("display_name"),
    supabaseAdmin.from("model_multipliers").select("*").order("created_at", { ascending: false }).limit(500),
    quotaRpc<ModelUsage[]>("model_multiplier_usage", { p_since: since }),
  ]);
  if (models.error) throw new Error(models.error.message);
  if (history.error) throw new Error(history.error.message);
  const rows = ((history.data ?? []) as MultiplierRow[]).map((r) => ({ ...r, multiplier: Number(r.multiplier) }));
  const usageRows = (usage ?? []).map((u) => ({ ...u, calls: Number(u.calls), users: Number(u.users), base_billable: Number(u.base_billable), billable: Number(u.billable), cost_usd: Number(u.cost_usd) }));

  const list: MultiplierModel[] = (models.data ?? []).map((m) => {
    const provider = (Array.isArray(m.providers) ? m.providers[0] : m.providers) as { slug?: string } | null;
    const slug = provider?.slug ?? "unknown";
    const modelId = m.model_id as string;
    const live = rows.filter((r) => !r.cancelled_at);
    const current = resolveMultiplier(live, slug, modelId, now);
    const row = current.id ? rows.find((r) => r.id === current.id) ?? null : null;
    const own = rows.filter((r) => r.model_id === modelId && r.provider_slug === slug);
    return {
      provider_slug: slug,
      model_id: modelId,
      display_name: (m.display_name as string) || modelId,
      enabled: Boolean(m.is_enabled_for_users),
      min_tier: (m.min_tier as string) ?? null,
      current: { ...current, kind: row?.kind ?? null, until: row?.effective_to ?? null },
      scheduled: own.filter((r) => !r.cancelled_at && t(r.effective_from) > now),
      latest_id: own[0]?.id ?? null,
      usage30d: usageRows.find((u) => u.provider_slug === slug && u.model_id === modelId) ?? null,
    };
  });
  return { models: list, history: rows.slice(0, 200), maxMultiplier: MAX_MULTIPLIER, since };
}

/**
 * What a proposed multiplier would have charged over the last 30 days of real usage. A projection
 * from past traffic, labelled as such in the UI — not a forecast of future demand.
 */
export function previewImpact(usage: ModelUsage | null, proposed: number) {
  const base = usage?.base_billable ?? 0;
  return {
    calls: usage?.calls ?? 0,
    users: usage?.users ?? 0,
    baseBillable: base,
    chargedBillable: usage?.billable ?? 0,
    projectedBillable: applyMultiplier(base, proposed),
    providerCostUsd: usage?.cost_usd ?? 0,
  };
}
