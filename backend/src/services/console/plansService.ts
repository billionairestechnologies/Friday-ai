import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { resolveEffectivePlan } from "../quota/tokenQuotaService.js";
import { NEW_USER_DAYS, findUserByEmail, userLabels } from "./directory.js";

/**
 * Plans & Offers. Everything here resolves to ONE primitive — an access grant — which writes the
 * columns the quota system already reads (profiles.plan / plan_renews_at / custom_monthly_cap for a
 * person, organizations.plan / seat_count / pooled_monthly_tokens for an enterprise) and keeps a row
 * in access_grants so there's a record of who gave what, why, and until when.
 *
 * Expiry: plan_renews_at on its own is never enforced (paid renewals arrive by webhook and must not
 * be cut off if one is late), so grants carry their own ends_at and expireGrants() reverts ONLY
 * access that a grant gave and nothing has since replaced.
 */

type IndividualPlan = "free" | "pro" | "premium";

// ── Packages ─────────────────────────────────────────────────────────────────

export type PackageInput = {
  name: string;
  description?: string;
  target: "individual" | "organization";
  plan: "free" | "pro" | "premium" | "enterprise";
  monthlyTokenCap?: number | null;
  seats?: number | null;
  pooledMonthlyTokens?: number | null;
  durationDays?: number | null;
  pricePaise?: number;
  currency?: string;
  features?: string[];
  active?: boolean;
};

function packageRow(input: Partial<PackageInput>) {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) row.name = input.name;
  if (input.description !== undefined) row.description = input.description;
  if (input.target !== undefined) row.target = input.target;
  if (input.plan !== undefined) row.plan = input.plan;
  if (input.monthlyTokenCap !== undefined) row.monthly_token_cap = input.monthlyTokenCap;
  if (input.seats !== undefined) row.seats = input.seats;
  if (input.pooledMonthlyTokens !== undefined) row.pooled_monthly_tokens = input.pooledMonthlyTokens;
  if (input.durationDays !== undefined) row.duration_days = input.durationDays;
  if (input.pricePaise !== undefined) row.price_paise = input.pricePaise;
  if (input.currency !== undefined) row.currency = input.currency;
  if (input.features !== undefined) row.features = input.features;
  if (input.active !== undefined) row.active = input.active;
  return row;
}

function validatePackage(input: Partial<PackageInput>) {
  if (input.target === "organization" && input.plan && input.plan !== "enterprise") throw new HttpError(400, "Organization packages use the Enterprise plan");
  if (input.target === "individual" && input.plan === "enterprise") throw new HttpError(400, "Individual packages use Free, Pro or Premium");
}

export async function listPackages() {
  const { data, error } = await supabaseAdmin.from("plan_packages").select("*").order("created_at", { ascending: false });
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

export async function savePackage(input: PackageInput & { id?: string }, actorId: string) {
  validatePackage(input);
  const row = packageRow(input);
  const { data, error } = input.id
    ? await supabaseAdmin.from("plan_packages").update(row).eq("id", input.id).select().single()
    : await supabaseAdmin.from("plan_packages").insert({ ...row, created_by: actorId }).select().single();
  if (error || !data) throw new HttpError(400, error?.message ?? "Couldn't save the package");
  return data;
}

export async function deletePackage(id: string) {
  // Archive rather than delete when grants/offers reference it — history must stay readable.
  const [{ count: grants }, { count: offers }] = await Promise.all([
    supabaseAdmin.from("access_grants").select("id", { count: "exact", head: true }).eq("package_id", id),
    supabaseAdmin.from("offers").select("id", { count: "exact", head: true }).eq("package_id", id),
  ]);
  if (grants || offers) {
    await supabaseAdmin.from("plan_packages").update({ active: false, updated_at: new Date().toISOString() }).eq("id", id);
    return { archived: true };
  }
  const { error } = await supabaseAdmin.from("plan_packages").delete().eq("id", id);
  if (error) throw new HttpError(500, error.message);
  return { archived: false };
}

// ── Grants ───────────────────────────────────────────────────────────────────

export type GrantInput = {
  userId?: string | null;
  organizationId?: string | null;
  plan: string;
  monthlyTokenCap?: number | null;
  seats?: number | null;
  pooledMonthlyTokens?: number | null;
  /** null = no end date. */
  durationDays?: number | null;
  source: "manual" | "package" | "offer";
  packageId?: string | null;
  offerId?: string | null;
  note?: string;
};

export function endsAtFor(durationDays: number | null | undefined, from = Date.now()): string | null {
  return durationDays ? new Date(from + durationDays * 86_400_000).toISOString() : null;
}

export async function grantAccess(input: GrantInput, actorId: string | null) {
  const endsAt = endsAtFor(input.durationDays);
  if (input.userId) {
    if (!["free", "pro", "premium"].includes(input.plan)) throw new HttpError(400, "A person can be granted Free, Pro or Premium");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ plan: input.plan as IndividualPlan, plan_renews_at: input.plan === "free" ? null : endsAt, custom_monthly_cap: input.monthlyTokenCap ?? null })
      .eq("id", input.userId);
    if (error) throw new HttpError(500, error.message);
    await supabaseAdmin.from("access_grants").update({ status: "revoked" }).eq("user_id", input.userId).eq("status", "active");
    resolveEffectivePlan.invalidate(input.userId);
  } else if (input.organizationId) {
    const seats = Math.max(1, input.seats ?? 1);
    const { error } = await supabaseAdmin
      .from("organizations")
      .update({
        plan: input.plan === "enterprise" ? "enterprise" : input.plan,
        seat_count: seats,
        ...(input.pooledMonthlyTokens != null ? { pooled_monthly_tokens: input.pooledMonthlyTokens } : {}),
      })
      .eq("id", input.organizationId);
    if (error) throw new HttpError(500, error.message);
    await supabaseAdmin.from("access_grants").update({ status: "revoked" }).eq("organization_id", input.organizationId).eq("status", "active");
  } else {
    throw new HttpError(400, "Choose a person or an organization");
  }
  const { data, error } = await supabaseAdmin
    .from("access_grants")
    .insert({
      user_id: input.userId ?? null,
      organization_id: input.organizationId ?? null,
      source: input.source,
      package_id: input.packageId ?? null,
      offer_id: input.offerId ?? null,
      plan: input.plan,
      monthly_token_cap: input.monthlyTokenCap ?? null,
      seats: input.seats ?? null,
      pooled_monthly_tokens: input.pooledMonthlyTokens ?? null,
      ends_at: endsAt,
      note: input.note ?? "",
      granted_by: actorId,
    })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't record the grant");
  return data;
}

export async function applyPackage(packageId: string, target: { userId?: string | null; organizationId?: string | null }, note: string, actorId: string | null) {
  const { data: pkg } = await supabaseAdmin.from("plan_packages").select("*").eq("id", packageId).maybeSingle();
  if (!pkg) throw new HttpError(404, "Package not found");
  if (pkg.target === "organization" && !target.organizationId) throw new HttpError(400, "This package is for organizations");
  if (pkg.target === "individual" && !target.userId) throw new HttpError(400, "This package is for individuals");
  return grantAccess(
    {
      ...target,
      plan: pkg.plan as string,
      monthlyTokenCap: pkg.monthly_token_cap as number | null,
      seats: pkg.seats as number | null,
      pooledMonthlyTokens: pkg.pooled_monthly_tokens as number | null,
      durationDays: pkg.duration_days as number | null,
      source: "package",
      packageId,
      note,
    },
    actorId,
  );
}

/** Undo what a grant gave (only if nothing has replaced it since). */
async function revert(grant: Record<string, unknown>) {
  if (grant.user_id) {
    const { data: profile } = await supabaseAdmin.from("profiles").select("plan").eq("id", grant.user_id).maybeSingle();
    // A paid order after the grant means the person now pays for their plan — leave it alone.
    const { count: paidSince } = await supabaseAdmin
      .from("razorpay_orders")
      .select("id", { count: "exact", head: true })
      .eq("user_id", grant.user_id)
      .eq("status", "paid")
      .gt("updated_at", grant.created_at as string);
    if (profile?.plan === grant.plan && !paidSince) {
      await supabaseAdmin.from("profiles").update({ plan: "free", plan_renews_at: null, custom_monthly_cap: null }).eq("id", grant.user_id);
      resolveEffectivePlan.invalidate(grant.user_id as string);
    }
  } else if (grant.organization_id) {
    const { data: org } = await supabaseAdmin.from("organizations").select("plan").eq("id", grant.organization_id).maybeSingle();
    if (org?.plan === grant.plan) await supabaseAdmin.from("organizations").update({ plan: "free" }).eq("id", grant.organization_id);
  }
}

export async function revokeGrant(grantId: string) {
  const { data: grant } = await supabaseAdmin.from("access_grants").select("*").eq("id", grantId).eq("status", "active").maybeSingle();
  if (!grant) throw new HttpError(404, "No active grant with that id");
  await revert(grant);
  await supabaseAdmin.from("access_grants").update({ status: "revoked" }).eq("id", grantId);
}

/** Hourly sweep: expire grants whose end date has passed. */
export async function expireGrants(): Promise<number> {
  const { data: due } = await supabaseAdmin.from("access_grants").select("*").eq("status", "active").lt("ends_at", new Date().toISOString()).limit(200);
  for (const grant of due ?? []) {
    await revert(grant).catch((err) => console.error("[plans] revert failed:", err instanceof Error ? err.message : err));
    await supabaseAdmin.from("access_grants").update({ status: "expired" }).eq("id", grant.id);
  }
  return due?.length ?? 0;
}

let sweep: NodeJS.Timeout | null = null;
export function startGrantExpirySweep(intervalMs = 60 * 60_000) {
  if (sweep || process.env.FRIDAY_DISABLE_GRANT_EXPIRY) return;
  sweep = setInterval(() => void expireGrants().catch(() => {}), intervalMs);
  sweep.unref?.();
  setTimeout(() => void expireGrants().catch(() => {}), 30_000).unref?.();
}

export async function listGrants(filter: { status?: string; userId?: string }) {
  let query = supabaseAdmin.from("access_grants").select("*").order("created_at", { ascending: false }).limit(300);
  if (filter.status) query = query.eq("status", filter.status);
  if (filter.userId) query = query.eq("user_id", filter.userId);
  const { data, error } = await query;
  if (error) throw new HttpError(500, error.message);
  const labels = await userLabels((data ?? []).flatMap((g) => [g.user_id as string | null, g.granted_by as string | null]));
  const orgIds = [...new Set((data ?? []).map((g) => g.organization_id as string | null).filter(Boolean))] as string[];
  const { data: orgs } = orgIds.length ? await supabaseAdmin.from("organizations").select("id, name").in("id", orgIds) : { data: [] };
  return (data ?? []).map((g) => ({
    ...g,
    user: g.user_id ? labels[g.user_id as string] ?? null : null,
    organization: g.organization_id ? ((orgs ?? []).find((o) => o.id === g.organization_id)?.name as string | undefined) ?? null : null,
    grantedBy: g.granted_by ? labels[g.granted_by as string]?.name ?? null : null,
  }));
}

export async function resolveTargetUser(emailOrId: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(emailOrId)) return emailOrId;
  const user = await findUserByEmail(emailOrId);
  if (!user) throw new HttpError(404, `No Friday account for ${emailOrId}`);
  return user.id;
}

// ── Offers ───────────────────────────────────────────────────────────────────

export type OfferInput = {
  code?: string;
  name: string;
  description?: string;
  kind: "plan_grant" | "package" | "discount";
  plan?: "pro" | "premium" | null;
  packageId?: string | null;
  durationDays?: number | null;
  discountPercent?: number | null;
  appliesToPlans?: string[];
  eligibility: "anyone" | "new_users" | "email_domain" | "student";
  emailDomains?: string[];
  requiresApproval?: boolean;
  maxRedemptions?: number | null;
  startsAt?: string | null;
  expiresAt?: string | null;
  active?: boolean;
};

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

export function generateCode(prefix = "FRIDAY"): string {
  return `${normalizeCode(prefix).slice(0, 12) || "FRIDAY"}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function offerRow(input: Partial<OfferInput>) {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.code !== undefined) row.code = normalizeCode(input.code);
  if (input.name !== undefined) row.name = input.name;
  if (input.description !== undefined) row.description = input.description;
  if (input.kind !== undefined) row.kind = input.kind;
  if (input.plan !== undefined) row.plan = input.plan;
  if (input.packageId !== undefined) row.package_id = input.packageId;
  if (input.durationDays !== undefined) row.duration_days = input.durationDays;
  if (input.discountPercent !== undefined) row.discount_percent = input.discountPercent;
  if (input.appliesToPlans !== undefined) row.applies_to_plans = input.appliesToPlans;
  if (input.eligibility !== undefined) row.eligibility = input.eligibility;
  if (input.emailDomains !== undefined) row.email_domains = input.emailDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  if (input.requiresApproval !== undefined) row.requires_approval = input.requiresApproval;
  if (input.maxRedemptions !== undefined) row.max_redemptions = input.maxRedemptions;
  if (input.startsAt !== undefined) row.starts_at = input.startsAt;
  if (input.expiresAt !== undefined) row.expires_at = input.expiresAt;
  if (input.active !== undefined) row.active = input.active;
  return row;
}

function validateOffer(input: Partial<OfferInput>) {
  if (input.kind === "plan_grant" && !input.plan) throw new HttpError(400, "Pick the plan this offer grants");
  if (input.kind === "package" && !input.packageId) throw new HttpError(400, "Pick the package this offer grants");
  if (input.kind === "discount" && !input.discountPercent) throw new HttpError(400, "Set the discount percentage");
  if (input.eligibility === "email_domain" && !(input.emailDomains ?? []).length) throw new HttpError(400, "Add at least one email domain");
}

export async function listOffers() {
  const { data, error } = await supabaseAdmin.from("offers").select("*").order("created_at", { ascending: false });
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

export async function saveOffer(input: OfferInput & { id?: string }, actorId: string) {
  validateOffer(input);
  const row = offerRow({ ...input, code: input.code?.trim() ? input.code : input.id ? undefined : generateCode(input.eligibility === "student" ? "STUDENT" : "FRIDAY") });
  const { data, error } = input.id
    ? await supabaseAdmin.from("offers").update(row).eq("id", input.id).select().single()
    : await supabaseAdmin.from("offers").insert({ ...row, created_by: actorId }).select().single();
  if (error || !data) throw new HttpError(400, error?.message?.includes("duplicate") ? "That code is already used by another offer" : (error?.message ?? "Couldn't save the offer"));
  return data;
}

export async function deleteOffer(id: string) {
  const { count } = await supabaseAdmin.from("offer_redemptions").select("id", { count: "exact", head: true }).eq("offer_id", id);
  if (count) {
    await supabaseAdmin.from("offers").update({ active: false, updated_at: new Date().toISOString() }).eq("id", id);
    return { archived: true };
  }
  const { error } = await supabaseAdmin.from("offers").delete().eq("id", id);
  if (error) throw new HttpError(500, error.message);
  return { archived: false };
}

/** Email-domain eligibility: "edu" matches x@mit.edu, "ac.in" matches x@iitb.ac.in, exact domains match exactly. */
export function emailMatchesDomains(email: string | null, domains: string[]): boolean {
  const domain = email?.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return domains.some((d) => {
    const want = d.toLowerCase().replace(/^[@.]/, "");
    return domain === want || domain.endsWith(`.${want}`);
  });
}

type OfferRow = Awaited<ReturnType<typeof listOffers>>[number];

async function loadRedeemableOffer(code: string): Promise<OfferRow> {
  const { data: offer } = await supabaseAdmin.from("offers").select("*").eq("code", normalizeCode(code)).maybeSingle();
  const now = new Date().toISOString();
  if (!offer || !offer.active) throw new HttpError(404, "That code isn't valid");
  if (offer.starts_at && (offer.starts_at as string) > now) throw new HttpError(400, "That offer hasn't started yet");
  if (offer.expires_at && (offer.expires_at as string) < now) throw new HttpError(400, "That offer has expired");
  if (offer.max_redemptions && (offer.redemption_count as number) >= (offer.max_redemptions as number)) throw new HttpError(400, "That offer has been fully claimed");
  return offer;
}

/** Whether a user may use an offer; returns "review" when it needs a teammate's approval. */
async function checkEligibility(offer: OfferRow, userId: string): Promise<"ok" | "review"> {
  const { data: auth } = await supabaseAdmin.auth.admin.getUserById(userId);
  const email = auth?.user?.email ?? null;
  const domains = (offer.email_domains as string[]) ?? [];
  switch (offer.eligibility) {
    case "new_users": {
      const created = auth?.user?.created_at ? Date.parse(auth.user.created_at) : 0;
      if (Date.now() - created > NEW_USER_DAYS * 86_400_000) throw new HttpError(403, "This offer is for new accounts only");
      break;
    }
    case "email_domain":
      if (!emailMatchesDomains(email, domains)) throw new HttpError(403, "This offer is for specific organisations — your email doesn't qualify");
      break;
    case "student":
      // A student email domain qualifies straight away; anyone else goes to the review queue with proof.
      if (domains.length && emailMatchesDomains(email, domains)) return offer.requires_approval ? "review" : "ok";
      return "review";
  }
  return offer.requires_approval ? "review" : "ok";
}

/** Atomically takes one redemption slot (compare-and-set, so a limited offer can't be over-claimed). */
async function claimSlot(offerId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: offer } = await supabaseAdmin.from("offers").select("redemption_count, max_redemptions").eq("id", offerId).single();
    if (!offer) throw new HttpError(404, "Offer not found");
    if (offer.max_redemptions && offer.redemption_count >= offer.max_redemptions) throw new HttpError(400, "That offer has been fully claimed");
    const { data: updated } = await supabaseAdmin
      .from("offers")
      .update({ redemption_count: (offer.redemption_count as number) + 1 })
      .eq("id", offerId)
      .eq("redemption_count", offer.redemption_count)
      .select("id")
      .maybeSingle();
    if (updated) return;
  }
  throw new HttpError(409, "Busy — please try again");
}

async function applyOffer(offer: OfferRow, userId: string, actorId: string | null) {
  if (offer.kind === "package" && offer.package_id) {
    return applyPackage(offer.package_id as string, { userId }, `Offer ${offer.code}`, actorId);
  }
  return grantAccess({ userId, plan: offer.plan as string, durationDays: offer.duration_days as number | null, source: "offer", offerId: offer.id as string, note: `Offer ${offer.code}` }, actorId);
}

export type RedeemResult =
  | { status: "applied"; plan: string; endsAt: string | null; message: string }
  | { status: "pending"; message: string }
  | { status: "discount"; percent: number; appliesTo: string[]; message: string };

/** A user redeems a code in the app. */
export async function redeem(userId: string, code: string, proof: string): Promise<RedeemResult> {
  const offer = await loadRedeemableOffer(code);
  if (offer.kind === "discount") {
    await checkEligibility(offer, userId);
    return {
      status: "discount",
      percent: offer.discount_percent as number,
      appliesTo: offer.applies_to_plans as string[],
      message: `${offer.discount_percent}% off ${((offer.applies_to_plans as string[]) ?? []).join(" / ")} — applied at checkout.`,
    };
  }
  const { data: existing } = await supabaseAdmin.from("offer_redemptions").select("status").eq("offer_id", offer.id).eq("user_id", userId).maybeSingle();
  if (existing?.status === "applied") throw new HttpError(400, "You've already used this code");
  if (existing?.status === "pending") return { status: "pending", message: "Your request is already with our team — you'll hear back by email." };
  if (existing?.status === "rejected") throw new HttpError(403, "This offer wasn't approved for your account");

  const verdict = await checkEligibility(offer, userId);
  if (verdict === "review") {
    if (offer.eligibility === "student" && proof.trim().length < 3) {
      throw new HttpError(400, "Tell us your college/university and course (and your student ID number) so we can verify you");
    }
    await supabaseAdmin.from("offer_redemptions").insert({ offer_id: offer.id, user_id: userId, status: "pending", proof: proof.slice(0, 2000) });
    return { status: "pending", message: "Thanks! Our team will verify this and email you — usually within a day." };
  }
  await claimSlot(offer.id as string);
  const grant = await applyOffer(offer, userId, null);
  await supabaseAdmin.from("offer_redemptions").upsert({ offer_id: offer.id, user_id: userId, status: "applied", proof: proof.slice(0, 2000) }, { onConflict: "offer_id,user_id" });
  return { status: "applied", plan: grant.plan as string, endsAt: grant.ends_at as string | null, message: `You're on ${grant.plan}${grant.ends_at ? ` until ${new Date(grant.ends_at as string).toDateString()}` : ""}.` };
}

export async function listRedemptions(status?: string) {
  let query = supabaseAdmin.from("offer_redemptions").select("*, offers(code, name, eligibility, kind, plan)").order("created_at", { ascending: false }).limit(300);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw new HttpError(500, error.message);
  const labels = await userLabels((data ?? []).map((r) => r.user_id as string));
  return (data ?? []).map((r) => ({ ...r, user: labels[r.user_id as string] ?? null }));
}

export async function reviewRedemption(redemptionId: string, approve: boolean, note: string, actorId: string) {
  const { data: redemption } = await supabaseAdmin.from("offer_redemptions").select("*").eq("id", redemptionId).eq("status", "pending").maybeSingle();
  if (!redemption) throw new HttpError(404, "No pending request with that id");
  const { data: offer } = await supabaseAdmin.from("offers").select("*").eq("id", redemption.offer_id).maybeSingle();
  if (!offer) throw new HttpError(404, "The offer no longer exists");
  if (approve) {
    await claimSlot(offer.id as string);
    await applyOffer(offer, redemption.user_id as string, actorId);
  }
  await supabaseAdmin
    .from("offer_redemptions")
    .update({ status: approve ? "applied" : "rejected", note, reviewed_by: actorId, reviewed_at: new Date().toISOString() })
    .eq("id", redemptionId);
  return { userId: redemption.user_id as string, offer };
}

export async function myRedemptions(userId: string) {
  const { data } = await supabaseAdmin.from("offer_redemptions").select("status, created_at, offers(code, name)").eq("user_id", userId).order("created_at", { ascending: false });
  return data ?? [];
}

// ── Checkout discounts ───────────────────────────────────────────────────────

/** Validates a discount code for a checkout; returns the percent and offer id, or throws. */
export async function discountForCheckout(userId: string, code: string, planId: string): Promise<{ offerId: string; percent: number }> {
  const offer = await loadRedeemableOffer(code);
  if (offer.kind !== "discount") throw new HttpError(400, "That code isn't a discount code — redeem it from Settings instead");
  if (!((offer.applies_to_plans as string[]) ?? []).includes(planId)) throw new HttpError(400, `That code doesn't apply to ${planId}`);
  const verdict = await checkEligibility(offer, userId);
  if (verdict === "review") throw new HttpError(403, "That discount needs approval first");
  const { data: used } = await supabaseAdmin.from("offer_redemptions").select("status").eq("offer_id", offer.id).eq("user_id", userId).eq("status", "applied").maybeSingle();
  if (used) throw new HttpError(400, "You've already used this discount");
  return { offerId: offer.id as string, percent: offer.discount_percent as number };
}

/** Called from the payment webhook once a discounted order is paid. */
export async function recordDiscountUse(offerId: string, userId: string, orderId: string) {
  await claimSlot(offerId).catch(() => {});
  await supabaseAdmin.from("offer_redemptions").upsert({ offer_id: offerId, user_id: userId, status: "applied", order_id: orderId }, { onConflict: "offer_id,user_id" });
}
