import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../utils/logger.js";

/**
 * When a paid individual plan starts and ends.
 *
 * Checkout sells one-time orders (30 or 365 days), not auto-renewing subscriptions, so the server has
 * to decide what a purchase does to the plan the person already has:
 *
 *   - Higher plan (Pro → Premium): starts now. The unused days of the old plan are converted to days
 *     of the new one at the two plans' price ratio, so nobody loses money by upgrading early.
 *   - Same plan: the new period is added to the end of the current one (an early renewal never
 *     wipes out days already paid for).
 *   - Lower plan (Premium → Pro): does NOT start now. It is stored as the scheduled plan and becomes
 *     the active plan when the current period ends. (Before this, the webhook switched the plan the
 *     moment the payment landed and the Premium days already paid for were lost.)
 *
 * And what happens at the end of a period: the scheduled plan rolls in; with none, the plan lapses to
 * Free after a grace window (plan_renews_at used to be display-only, so a single ₹999 order kept Pro
 * forever).
 *
 * The decisions are pure functions (tested in test/planSchedule.test.ts); the DB helpers apply them
 * with a compare-and-set on plan_renews_at so two instances, or the sweep racing a webhook, can't
 * both apply a change.
 */

export type PaidPlan = "pro" | "premium";
export type IndividualPlan = "free" | PaidPlan;

const RANK: Record<IndividualPlan, number> = { free: 0, pro: 1, premium: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;

export type PlanState = {
  plan: IndividualPlan;
  renewsAt: Date | null;
  scheduledPlan: PaidPlan | null;
  scheduledDays: number | null;
  /** plan_renews_at exactly as stored (microseconds included) — the compare-and-set key. */
  renewsAtRaw?: string | null;
};

export type Purchase = {
  plan: PaidPlan;
  days: number;
  /** Monthly price of each plan, used to convert unused days on an upgrade. */
  monthlyPricePaise: Record<PaidPlan, number>;
};

export type PurchaseDecision =
  | { kind: "apply"; plan: PaidPlan; renewsAt: Date; creditedDays: number }
  | { kind: "extend"; plan: PaidPlan; renewsAt: Date }
  | { kind: "schedule"; plan: PaidPlan; startsAt: Date; days: number };

/** A paid plan with time left (null renewsAt = granted with no end, treated as active). */
export function isActivePaid(state: Pick<PlanState, "plan" | "renewsAt">, now: Date): boolean {
  if (state.plan === "free") return false;
  return state.renewsAt == null || state.renewsAt.getTime() > now.getTime();
}

export function decidePurchase(state: PlanState, purchase: Purchase, now: Date): PurchaseDecision {
  const active = isActivePaid(state, now);
  const addDays = (from: Date, days: number) => new Date(from.getTime() + days * DAY_MS);

  if (!active) return { kind: "apply", plan: purchase.plan, renewsAt: addDays(now, purchase.days), creditedDays: 0 };

  if (purchase.plan === state.plan) {
    // No end date (an open-ended grant) — start counting from now rather than adding to "forever".
    const from = state.renewsAt && state.renewsAt > now ? state.renewsAt : now;
    return { kind: "extend", plan: purchase.plan, renewsAt: addDays(from, purchase.days) };
  }

  if (RANK[purchase.plan] > RANK[state.plan]) {
    let creditedDays = 0;
    if (state.renewsAt && state.plan !== "free") {
      const remainingDays = (state.renewsAt.getTime() - now.getTime()) / DAY_MS;
      const oldPrice = purchase.monthlyPricePaise[state.plan];
      const newPrice = purchase.monthlyPricePaise[purchase.plan];
      if (remainingDays > 0 && oldPrice > 0 && newPrice > 0) creditedDays = Math.floor(remainingDays * (oldPrice / newPrice));
    }
    return { kind: "apply", plan: purchase.plan, renewsAt: addDays(now, purchase.days + creditedDays), creditedDays };
  }

  // Downgrade while the higher plan is still running: wait for it to end.
  const days = state.scheduledPlan === purchase.plan ? (state.scheduledDays ?? 0) + purchase.days : purchase.days;
  return { kind: "schedule", plan: purchase.plan, startsAt: state.renewsAt ?? now, days };
}

/**
 * Whether checkout may sell this plan. A different plan already scheduled would be paid for and then
 * overwritten, so that is refused until it has started.
 */
export function purchaseBlockedReason(state: PlanState, plan: PaidPlan, now: Date): string | null {
  if (!state.scheduledPlan || state.scheduledPlan === plan) return null;
  if (!isActivePaid(state, now)) return null;
  if (plan === state.plan) return null; // extending the current plan just pushes the scheduled one later
  const when = state.renewsAt ? state.renewsAt.toISOString().slice(0, 10) : "the end of your current plan";
  return `Your ${cap(state.scheduledPlan)} plan is already booked to start on ${when}. You can buy another plan once it has started.`;
}

export type RolloverDecision =
  | { kind: "none" }
  | { kind: "start_scheduled"; plan: PaidPlan; renewsAt: Date }
  | { kind: "lapse" };

export function decideRollover(state: PlanState, now: Date, graceMs: number): RolloverDecision {
  if (state.plan === "free" || !state.renewsAt) return { kind: "none" };
  if (state.renewsAt.getTime() > now.getTime()) return { kind: "none" };
  if (state.scheduledPlan && state.scheduledDays) {
    // Starts at the moment the old plan ended, not when the sweep noticed, so no day is lost.
    return { kind: "start_scheduled", plan: state.scheduledPlan, renewsAt: new Date(state.renewsAt.getTime() + state.scheduledDays * DAY_MS) };
  }
  if (now.getTime() - state.renewsAt.getTime() >= graceMs) return { kind: "lapse" };
  return { kind: "none" };
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── DB ───────────────────────────────────────────────────────────────────────

const PROFILE_COLUMNS = "plan, plan_renews_at, scheduled_plan, scheduled_plan_days";

type ProfileRow = { plan: string | null; plan_renews_at: string | null; scheduled_plan: string | null; scheduled_plan_days: number | null };

export function stateFromRow(row: ProfileRow | null): PlanState {
  const plan = row?.plan === "pro" || row?.plan === "premium" ? row.plan : "free";
  const scheduled = row?.scheduled_plan === "pro" || row?.scheduled_plan === "premium" ? row.scheduled_plan : null;
  return {
    plan,
    renewsAt: row?.plan_renews_at ? new Date(row.plan_renews_at) : null,
    renewsAtRaw: row?.plan_renews_at ?? null,
    scheduledPlan: scheduled,
    scheduledDays: scheduled ? row?.scheduled_plan_days ?? null : null,
  };
}

export async function loadPlanState(userId: string): Promise<PlanState> {
  const { data, error } = await supabaseAdmin.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  return stateFromRow(data as ProfileRow | null);
}

/** Only change the row if plan_renews_at is still what we read (compare-and-set). */
function whereUnchanged<T extends { eq: (c: string, v: unknown) => T; is: (c: string, v: null) => T }>(query: T, userId: string, state: PlanState): T {
  const q = query.eq("id", userId);
  const stored = state.renewsAtRaw !== undefined ? state.renewsAtRaw : state.renewsAt?.toISOString() ?? null;
  return stored ? q.eq("plan_renews_at", stored) : q.is("plan_renews_at", null);
}

/** Apply a paid order to the person's plan. Retries once if the row moved under it. */
export async function applyPlanPurchase(userId: string, purchase: Purchase, orderId: string): Promise<PurchaseDecision> {
  for (let attempt = 0; ; attempt++) {
    const state = await loadPlanState(userId);
    const now = new Date();
    const decision = decidePurchase(state, purchase, now);
    const patch =
      decision.kind === "schedule"
        ? { scheduled_plan: decision.plan, scheduled_plan_days: decision.days, scheduled_plan_order_id: orderId }
        : {
            plan: decision.plan,
            plan_renews_at: decision.renewsAt.toISOString(),
            // A downgrade booked earlier is superseded once the person pays for something higher now.
            ...(decision.kind === "apply" ? { scheduled_plan: null, scheduled_plan_days: null, scheduled_plan_order_id: null } : {}),
          };
    const { data, error } = await whereUnchanged(supabaseAdmin.from("profiles").update(patch), userId, state).select("id");
    if (error) throw new Error(error.message);
    if (data?.length) {
      logger.info("plan_purchase_applied", { userId, orderId, decision: decision.kind, plan: decision.plan });
      return decision;
    }
    if (attempt >= 2) throw new Error("plan row kept changing while applying the purchase");
  }
}

/** Start a due scheduled plan, or lapse an expired one. Returns true when the row changed. */
export async function rolloverUser(userId: string, state: PlanState, now = new Date()): Promise<boolean> {
  const decision = decideRollover(state, now, planExpiryGraceMs());
  if (decision.kind === "none") return false;
  if (decision.kind === "lapse") {
    // A console grant manages its own expiry (plansService.expireGrants) — never lapse on top of it.
    const { count } = await supabaseAdmin.from("access_grants").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "active");
    if (count) return false;
    if (process.env.FRIDAY_DISABLE_PLAN_EXPIRY) return false;
  }
  const patch =
    decision.kind === "start_scheduled"
      ? { plan: decision.plan, plan_renews_at: decision.renewsAt.toISOString(), scheduled_plan: null, scheduled_plan_days: null, scheduled_plan_order_id: null }
      : { plan: "free", plan_renews_at: null, custom_monthly_cap: null };
  const { data, error } = await whereUnchanged(supabaseAdmin.from("profiles").update(patch), userId, state).select("id");
  if (error) throw new Error(error.message);
  if (data?.length) logger.info("plan_rollover", { userId, decision: decision.kind, from: state.plan, to: decision.kind === "lapse" ? "free" : decision.plan });
  return Boolean(data?.length);
}

export function planExpiryGraceMs(): number {
  const hours = Number(process.env.FRIDAY_PLAN_EXPIRY_GRACE_HOURS ?? 24);
  return (Number.isFinite(hours) && hours >= 0 ? hours : 24) * 60 * 60 * 1000;
}

/** One pass over plans whose period has ended. Safe on every instance (compare-and-set per row). */
export async function rolloverDuePlans(limit = 500): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select(`id, ${PROFILE_COLUMNS}`)
    .in("plan", ["pro", "premium"])
    .lte("plan_renews_at", new Date().toISOString())
    .order("plan_renews_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  let changed = 0;
  for (const row of data ?? []) {
    try {
      if (await rolloverUser(row.id as string, stateFromRow(row as ProfileRow))) changed++;
    } catch (err) {
      logger.warn("plan_rollover_failed", { userId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return changed;
}

let timer: NodeJS.Timeout | null = null;
/** Every 10 minutes; the quota path also rolls a single user over the moment their plan ends. */
export function startPlanRolloverSweep(intervalMs = 10 * 60_000, onChange?: () => void) {
  if (timer) return;
  const run = () =>
    void rolloverDuePlans()
      .then((n) => n > 0 && onChange?.())
      .catch((err) => logger.warn("plan_rollover_sweep_failed", { error: err instanceof Error ? err.message : String(err) }));
  timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, 45_000).unref?.();
}
