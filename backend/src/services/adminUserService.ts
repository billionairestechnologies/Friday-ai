import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { ENTERPRISE_MIN_SEATS, ENTERPRISE_TOKENS_PER_SEAT, type Plan } from "./quota/tierConfig.js";

export type AdminUserRow = {
  id: string;
  fullName: string | null;
  role: string;
  plan: Plan;
  planRenewsAt: string | null;
  customMonthlyCap: number | null;
  organizationId: string | null;
  organizationName: string | null;
};

/** Every user, for the admin panel's "Plans" table — paginated in the frontend, not here, since
 *  the expected scale here is hundreds/low-thousands of users, not millions. */
export async function listUsersForAdmin(): Promise<AdminUserRow[]> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, role, plan, plan_renews_at, custom_monthly_cap")
    .order("full_name");
  if (error) throw new HttpError(500, error.message);

  const { data: memberships } = await supabaseAdmin
    .from("organization_memberships")
    .select("user_id, organizations(id, name)");
  const orgByUser = new Map<string, { id: string; name: string }>();
  for (const row of memberships ?? []) {
    const org = row.organizations as { id: string; name: string } | { id: string; name: string }[] | null;
    const resolved = Array.isArray(org) ? org[0] : org;
    if (resolved) orgByUser.set(row.user_id as string, resolved);
  }

  return (data ?? []).map((row) => {
    const org = orgByUser.get(row.id as string);
    return {
      id: row.id as string,
      fullName: row.full_name as string | null,
      role: row.role as string,
      plan: (row.plan as Plan) ?? "free",
      planRenewsAt: row.plan_renews_at as string | null,
      customMonthlyCap: row.custom_monthly_cap as number | null,
      organizationId: org?.id ?? null,
      organizationName: org?.name ?? null,
    };
  });
}

export async function setUserPlan(userId: string, plan: Plan, renewsInDays = 30): Promise<void> {
  const planRenewsAt = new Date(Date.now() + renewsInDays * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ plan, plan_renews_at: plan === "free" ? null : planRenewsAt })
    .eq("id", userId);
  if (error) throw new HttpError(500, error.message);
}

export async function setUserCustomCap(userId: string, customMonthlyCap: number | null): Promise<void> {
  const { error } = await supabaseAdmin.from("profiles").update({ custom_monthly_cap: customMonthlyCap }).eq("id", userId);
  if (error) throw new HttpError(500, error.message);
}

export type AdminOrganizationRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  seatCount: number;
  pooledMonthlyTokens: number;
  memberCount: number;
};

export async function listOrganizationsForAdmin(): Promise<AdminOrganizationRow[]> {
  const { data, error } = await supabaseAdmin
    .from("organizations")
    .select("id, name, slug, plan, seat_count, pooled_monthly_tokens")
    .order("name");
  if (error) throw new HttpError(500, error.message);

  const { data: memberships } = await supabaseAdmin.from("organization_memberships").select("organization_id");
  const counts = new Map<string, number>();
  for (const row of memberships ?? []) {
    const id = row.organization_id as string;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return (data ?? []).map((row) => {
    const seatCount = (row.seat_count as number) ?? ENTERPRISE_MIN_SEATS;
    return {
      id: row.id as string,
      name: row.name as string,
      slug: row.slug as string,
      plan: row.plan as string,
      seatCount,
      pooledMonthlyTokens: (row.pooled_monthly_tokens as number | null) ?? seatCount * ENTERPRISE_TOKENS_PER_SEAT,
      memberCount: counts.get(row.id as string) ?? 0,
    };
  });
}

export async function setOrganizationPlan(organizationId: string, plan: "free" | "pro" | "business" | "enterprise") {
  const { error } = await supabaseAdmin.from("organizations").update({ plan }).eq("id", organizationId);
  if (error) throw new HttpError(500, error.message);
}

export async function setOrganizationSeats(organizationId: string, seatCount: number): Promise<void> {
  if (seatCount < ENTERPRISE_MIN_SEATS) throw new HttpError(400, `Enterprise orgs need at least ${ENTERPRISE_MIN_SEATS} seats`);
  const { error } = await supabaseAdmin
    .from("organizations")
    .update({ seat_count: seatCount, pooled_monthly_tokens: seatCount * ENTERPRISE_TOKENS_PER_SEAT })
    .eq("id", organizationId);
  if (error) throw new HttpError(500, error.message);
}

export async function setOrganizationPooledTokens(organizationId: string, pooledMonthlyTokens: number): Promise<void> {
  const { error } = await supabaseAdmin
    .from("organizations")
    .update({ pooled_monthly_tokens: pooledMonthlyTokens })
    .eq("id", organizationId);
  if (error) throw new HttpError(500, error.message);
}

// tokenUsage.ts's estimateCostCents() is explicitly USD cents (see its own comment); Razorpay
// revenue is INR paise. This is a fixed approximate conversion purely for a single "are we
// profitable" number in the admin panel — not an accounting-grade FX rate, and worth revisiting
// if this ever needs to be precise (a live rate lookup, or re-denominating provider cost tracking
// in INR directly).
const APPROX_USD_TO_INR = 83;

/** Revenue (captured Razorpay payments, INR) vs. estimated provider cost (token_ledger, converted
 *  from USD) — the admin panel's profitability card. `sinceDays` bounds both sums to the same
 *  window. Returns everything in INR paise so the two sides are actually comparable. */
export async function profitabilitySummary(sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: paidOrders, error: ordersError } = await supabaseAdmin
    .from("razorpay_orders")
    .select("amount_paise")
    .eq("status", "paid")
    .gte("created_at", since);
  if (ordersError) throw new HttpError(500, ordersError.message);
  const revenuePaise = (paidOrders ?? []).reduce((sum, row) => sum + Number(row.amount_paise ?? 0), 0);

  const { data: ledgerRows, error: ledgerError } = await supabaseAdmin
    .from("token_ledger")
    .select("estimated_cost_cents, total_tokens")
    .gte("created_at", since);
  if (ledgerError) throw new HttpError(500, ledgerError.message);
  const costUsdCents = (ledgerRows ?? []).reduce((sum, row) => sum + Number(row.estimated_cost_cents ?? 0), 0);
  const costInrPaise = costUsdCents * APPROX_USD_TO_INR;
  const totalTokens = (ledgerRows ?? []).reduce((sum, row) => sum + Number(row.total_tokens ?? 0), 0);

  return {
    sinceDays,
    revenuePaise: Math.round(revenuePaise),
    costUsdCents: Math.round(costUsdCents),
    costPaiseApprox: Math.round(costInrPaise),
    profitPaiseApprox: Math.round(revenuePaise - costInrPaise),
    totalTokens,
    completions: (ledgerRows ?? []).length,
  };
}
