import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { pipelineSummary } from "./crmService.js";
import { searchUsers, type DirectoryUser } from "./directory.js";
import { supportStats } from "./supportService.js";

/** The console dashboard: growth, activity, revenue mix, support load and pipeline in one call. */
export async function overview() {
  const now = Date.now();
  const day = 86_400_000;
  const since = (days: number) => new Date(now - days * day).toISOString();

  const headCount = async (table: string, sinceIso?: string) => {
    let query = supabaseAdmin.from(table).select("id", { count: "exact", head: true });
    if (sinceIso) query = query.gte("created_at", sinceIso);
    const { count: n } = await query;
    return n ?? 0;
  };

  const [totalUsers, plans, messages24h, messages7d, active24h, support, pipeline, campaigns, liveUpdates] = await Promise.all([
    headCount("profiles"),
    Promise.all(
      (["free", "pro", "premium"] as const).map(async (plan) => {
        const { count: n } = await supabaseAdmin.from("profiles").select("id", { count: "exact", head: true }).eq("plan", plan);
        return [plan, n ?? 0] as const;
      }),
    ),
    headCount("messages", since(1)),
    headCount("messages", since(7)),
    supabaseAdmin
      .from("usage_events")
      .select("user_id")
      .gte("created_at", since(1))
      .limit(10000)
      .then(({ data }) => new Set((data ?? []).map((r) => r.user_id)).size),
    supportStats().catch(() => null),
    pipelineSummary().catch(() => []),
    supabaseAdmin
      .from("email_campaigns")
      .select("id, name, status, sent_count, total_recipients, sent_at")
      .order("created_at", { ascending: false })
      .limit(5)
      .then(({ data }) => data ?? []),
    supabaseAdmin
      .from("announcements")
      .select("id", { count: "exact", head: true })
      .eq("status", "published")
      .then(({ count: n }) => n ?? 0),
  ]);

  // Signups per day for the last 14 days (from the directory, newest first).
  const recent: DirectoryUser[] = await searchUsers(null, 500).catch(() => []);
  const signups: { date: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * day).toISOString().slice(0, 10);
    signups.push({ date: d, count: recent.filter((u) => u.created_at.slice(0, 10) === d).length });
  }
  const new7d = recent.filter((u) => new Date(u.created_at).getTime() >= now - 7 * day).length;

  return {
    users: { total: totalUsers, new7d, active24h, plans: Object.fromEntries(plans) },
    activity: { messages24h, messages7d },
    signups,
    support,
    pipeline,
    campaigns,
    liveUpdates,
  };
}

// ── Users (console) ──────────────────────────────────────────────────────────

export async function userDetail(userId: string) {
  const [{ data: auth }, { data: profile }, { data: tickets }, { data: contact }] = await Promise.all([
    supabaseAdmin.auth.admin.getUserById(userId),
    supabaseAdmin.from("profiles").select("full_name, plan, plan_renews_at, custom_monthly_cap, role, marketing_opt_out, phone").eq("id", userId).maybeSingle(),
    supabaseAdmin.from("support_tickets").select("id, number, subject, status, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(10),
    supabaseAdmin.from("crm_contacts").select("id, name, stage_id, kind").eq("user_id", userId).maybeSingle(),
  ]);
  if (!auth?.user) throw new HttpError(404, "User not found");
  const { count: conversations } = await supabaseAdmin.from("conversations").select("id", { count: "exact", head: true }).eq("user_id", userId);
  const { data: usage } = await supabaseAdmin
    .from("usage_events")
    .select("event_type, quantity")
    .eq("user_id", userId)
    .gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString())
    .limit(5000);
  const usage30d: Record<string, number> = {};
  for (const e of usage ?? []) usage30d[e.event_type as string] = (usage30d[e.event_type as string] ?? 0) + Number(e.quantity ?? 1);
  return {
    id: userId,
    email: auth.user.email ?? null,
    name: profile?.full_name ?? null,
    phone: profile?.phone ?? null,
    plan: profile?.plan ?? "free",
    planRenewsAt: profile?.plan_renews_at ?? null,
    customMonthlyCap: profile?.custom_monthly_cap ?? null,
    role: profile?.role ?? "user",
    marketingOptOut: Boolean(profile?.marketing_opt_out),
    createdAt: auth.user.created_at,
    lastSignInAt: auth.user.last_sign_in_at ?? null,
    bannedUntil: (auth.user as { banned_until?: string }).banned_until ?? null,
    conversations: conversations ?? 0,
    usage30d,
    tickets: tickets ?? [],
    crmContact: contact ?? null,
  };
}

/** Suspends (bans) or restores a user's ability to sign in. */
export async function setSuspended(userId: string, suspended: boolean) {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: suspended ? "876000h" : "none" });
  if (error) throw new HttpError(500, error.message);
}
