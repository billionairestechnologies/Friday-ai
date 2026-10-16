import { createHash } from "node:crypto";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../utils/logger.js";
import { getRedisClient } from "../redisClient.js";
import { notifyUser } from "../pushService.js";
import { alertTeam } from "../status/statusService.js";
import { quotaRpc } from "./tokenQuotaService.js";
import { setUsageNoticeSink } from "./usageMeter.js";

/**
 * Background upkeep for the monthly allowance. Every step is a row-locked, idempotent SQL function,
 * so two instances running it at once can't double-release or double-expire anything; a short Redis
 * lease only keeps the team from getting the same alert twice.
 *
 *  1. Release holds of requests that stopped reporting (crashed mid-turn). Live requests heartbeat
 *     on every model round and no turn runs past ~40 minutes, so 2 hours idle is never a live one.
 *  2. Expire lapsed paid terms (queued downgrade starts, or the account drops to Free).
 *  3. Reconcile: recompute every balance from the ledger + adjustments + holds (quota_audit).
 *  4. Alert on discrepancies, overspend past tolerance (a bypass), unusual spikes and a high share
 *     of estimated (not provider-reported) usage.
 */

const STALE_HOLD = "2 hours";
const SPIKE_SHARE = 0.25; // a quarter of the month in one hour
const OVERSPEND_TOLERANCE = 0.05;
const ALERT_COOLDOWN_MS = 6 * 60 * 60_000;
const INTERVAL_MS = 10 * 60_000;

const sentLocally = new Map<string, number>();

async function alertOnce(subject: string, markdown: string): Promise<void> {
  const key = `quota:alert:${createHash("sha256").update(subject + markdown).digest("hex").slice(0, 24)}`;
  const redis = await getRedisClient().catch(() => null);
  if (redis) {
    const got = await redis.set(key, "1", { NX: true, PX: ALERT_COOLDOWN_MS }).catch(() => "OK");
    if (got !== "OK") return;
  } else {
    const last = sentLocally.get(key) ?? 0;
    if (Date.now() - last < ALERT_COOLDOWN_MS) return;
    sentLocally.set(key, Date.now());
  }
  logger.warn("quota_alert", { subject });
  await alertTeam(subject, markdown);
}

export type MaintenanceResult = {
  releasedHolds: number;
  expiredTerms: number;
  discrepancies: Array<{ account_id: string; field: string; stored: number; computed: number }>;
  overspent: Array<{ account_id: string; consumed: number; allowance: number }>;
  spikes: Array<{ account_id: string; billable: number; allowance: number }>;
  estimatedShareLastHour: number;
};

export async function runQuotaMaintenance(opts: { alert: boolean } = { alert: true }): Promise<MaintenanceResult> {
  const releasedHolds = Number(await quotaRpc("quota_expire_stale_reservations", { p_idle: STALE_HOLD })) || 0;
  const expiredTerms = Number(await quotaRpc("quota_expire_all_due", {})) || 0;
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const [discrepancies, overspent, spikes, estimated, chargeable] = await Promise.all([
    quotaRpc<MaintenanceResult["discrepancies"]>("quota_audit", {}),
    quotaRpc<MaintenanceResult["overspent"]>("quota_overspent", { p_tolerance: OVERSPEND_TOLERANCE }),
    quotaRpc<MaintenanceResult["spikes"]>("quota_spikes", { p_since: since, p_share: SPIKE_SHARE }),
    supabaseAdmin.from("token_ledger").select("id", { count: "exact", head: true }).eq("usage_source", "estimated").gt("billable_tokens", 0).gte("created_at", since),
    supabaseAdmin.from("token_ledger").select("id", { count: "exact", head: true }).gt("billable_tokens", 0).gte("created_at", since),
  ]);
  const estimatedShareLastHour = (chargeable.count ?? 0) >= 20 ? (estimated.count ?? 0) / (chargeable.count ?? 1) : 0;
  const result: MaintenanceResult = {
    releasedHolds,
    expiredTerms,
    discrepancies: discrepancies ?? [],
    overspent: overspent ?? [],
    spikes: spikes ?? [],
    estimatedShareLastHour: Math.round(estimatedShareLastHour * 1000) / 1000,
  };
  if (releasedHolds || expiredTerms || result.discrepancies.length || result.overspent.length || result.spikes.length) {
    logger.info("quota_maintenance", { ...result, discrepancies: result.discrepancies.length, overspent: result.overspent.length, spikes: result.spikes.length });
  }
  if (opts.alert) {
    const list = (rows: Array<Record<string, unknown>>) => rows.slice(0, 20).map((r) => `- ${Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(", ")}`).join("\n");
    if (result.discrepancies.length) {
      await alertOnce("Usage ledger discrepancy", `The stored balance of ${result.discrepancies.length} account(s) doesn't match the ledger. Open Console → Usage ledger.\n\n${list(result.discrepancies)}`);
    }
    if (result.overspent.length) {
      await alertOnce("Usage past allowance", `${result.overspent.length} account(s) are more than ${OVERSPEND_TOLERANCE * 100}% over their allowance — possible quota bypass.\n\n${list(result.overspent)}`);
    }
    if (result.spikes.length) {
      await alertOnce("Unusual usage spike", `${result.spikes.length} account(s) used over ${SPIKE_SHARE * 100}% of their monthly tokens in the last hour.\n\n${list(result.spikes)}`);
    }
    if (estimatedShareLastHour > 0.2) {
      await alertOnce("Missing provider usage", `${Math.round(estimatedShareLastHour * 100)}% of charged calls in the last hour had no usage from the provider and were estimated. Check the provider adapters / supplier.`);
    }
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startQuotaMaintenance() {
  if (timer || process.env.FRIDAY_DISABLE_QUOTA_JOBS) return;
  // Usage notices (80 / 95 / 100 %): the SQL marks each threshold once per period, so this fires once.
  setUsageNoticeSink((userId, threshold, periodEnd) => {
    const renews = periodEnd ? new Date(periodEnd).toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "Asia/Kolkata" }) : null;
    void notifyUser(userId, {
      title: threshold >= 100 ? "You've used all of this month's tokens" : `You've used ${threshold}% of this month's tokens`,
      body: threshold >= 100
        ? `New requests are paused until your allowance renews${renews ? ` on ${renews}` : ""}, or upgrade to continue now.`
        : `Your allowance renews${renews ? ` on ${renews}` : " at the start of your next period"}. See Settings → Usage for details.`,
    }).catch(() => undefined);
  });
  const tick = () => void runQuotaMaintenance().catch((err) => logger.error("quota_maintenance_failed", { error: err instanceof Error ? err.message : String(err) }));
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, 60_000).unref?.();
}
