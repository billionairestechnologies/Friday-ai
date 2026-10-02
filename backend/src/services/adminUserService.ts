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

/**
 * Revenue vs. AI cost for the admin Billing card. Now a thin view over the Finance report
 * (finance/report.ts): exact per-model prices instead of one flat guess per provider, an aggregate
 * in the database instead of a select silently capped at 1000 rows, and the books' USD→INR rate
 * instead of a hard-coded 83. Same response shape as before so the existing card keeps working.
 */
export async function profitabilitySummary(sinceDays = 30) {
  const { financeReport } = await import("./finance/report.js");
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (sinceDays - 1) * 86_400_000).toISOString().slice(0, 10);
  const report = await financeReport(from, to);
  const totalTokens = report.models.reduce((n, m) => n + m.inputTokens + m.outputTokens, 0);
  const completions = report.models.reduce((n, m) => n + m.calls, 0);
  return {
    sinceDays,
    revenuePaise: Math.round(report.totals.revenueInr * 100),
    costUsdCents: Math.round((report.totals.aiCostInr / report.settings.usd_to_inr) * 100),
    costPaiseApprox: Math.round(report.totals.aiCostInr * 100),
    profitPaiseApprox: Math.round(report.totals.grossProfitInr * 100),
    totalTokens,
    completions,
  };
}
