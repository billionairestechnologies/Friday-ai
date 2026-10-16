import { applyPackage, discountForCheckout, listPublicPackages, recordDiscountUse } from "./console/plansService.js";
import { annualPricePaise, getCatalogPlan, getPlanCatalog, type CatalogPlan } from "./quota/planCatalog.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { logger } from "../utils/logger.js";
import { ENTERPRISE_MIN_SEATS, ENTERPRISE_TOKENS_PER_SEAT } from "./quota/tierConfig.js";
import { requireOrgRole } from "./organizationService.js";
import { resolveEffectivePlan } from "./quota/tokenQuotaService.js";

export type BillingCycle = "monthly" | "annual";

// Individual plans — profiles.plan is exactly ('free' | 'pro' | 'premium'), so these ids match
// that enum directly (no more of the old pro/business→pro/premium name mapping).
export const INDIVIDUAL_PLANS = [
  {
    id: "pro",
    name: "Friday Pro",
    monthlyAmountPaise: 99_900, // ₹999
    description: "Higher personal limits for chat, search, voice, and Canvas.",
  },
  {
    id: "premium",
    name: "Friday Premium",
    monthlyAmountPaise: 199_900, // ₹1,999
    description: "Highest personal limits, plus reasoning/flagship models.",
  },
] as const;

// A one-time payment covering 12 months at 10% off the monthly rate, rounded to the nearest
// rupee — matches the "annual toggle applies a 10% discount" ask. Not a subscription (one-time
// orders were chosen over Razorpay Subscriptions) — an annual purchase is a single order for a
// 12-month term, a monthly one for 1 calendar month. Either way the token allowance renews every
// month of the term, counted from the day it started (supabase 0057: quota_apply_payment).
export function annualAmountPaise(monthlyAmountPaise: number): number {
  return Math.round(monthlyAmountPaise * 12 * 0.9);
}

export function amountForCycle(monthlyAmountPaise: number, cycle: BillingCycle): number {
  return cycle === "annual" ? annualAmountPaise(monthlyAmountPaise) : monthlyAmountPaise;
}

// Enterprise is per-seat, min 3 seats, org-pooled — not an individual profiles.plan value.
export const ENTERPRISE_PLAN = {
  id: "enterprise",
  name: "Friday Enterprise",
  perSeatMonthlyAmountPaise: 249_900, // ₹2,499/seat/mo
  minSeats: ENTERPRISE_MIN_SEATS,
  description: `Pooled org-wide tokens (${(ENTERPRISE_TOKENS_PER_SEAT / 1_000_000).toFixed(0)}M/seat each month), every model.`,
} as const;

type OrderPlanId = "pro" | "premium" | "enterprise" | "package";

/** Prices come from the console-edited plan catalog (migration 0033); the constants above are the
 *  defaults it falls back to. */
function cycleAmount(plan: Pick<CatalogPlan, "monthlyPricePaise" | "annualDiscountPercent">, cycle: BillingCycle): number {
  return cycle === "annual" ? annualPricePaise(plan) : plan.monthlyPricePaise;
}

function requireRazorpayConfigured() {
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    throw new HttpError(503, "Razorpay billing is not configured yet");
  }
}

export async function publicBillingConfig() {
  const [catalog, packages] = await Promise.all([getPlanCatalog(), listPublicPackages()]);
  const pick = (id: string) => catalog.find((p) => p.id === id)!;
  const enterprise = pick("enterprise");
  return {
    provider: "razorpay",
    keyId: env.razorpayKeyId || null,
    currency: "INR",
    annualDiscountPercent: pick("pro").annualDiscountPercent,
    // Legacy shape (Android/iOS read these) — now filled from the catalog.
    individual: (["pro", "premium"] as const).map((id) => {
      const p = pick(id);
      return { id, name: `Friday ${p.name}`, description: p.tagline, monthlyAmountPaise: p.monthlyPricePaise, annualAmountPaise: annualPricePaise(p) };
    }),
    enterprise: {
      id: "enterprise",
      name: `Friday ${enterprise.name}`,
      perSeatMonthlyAmountPaise: enterprise.monthlyPricePaise,
      minSeats: enterprise.minSeats ?? ENTERPRISE_MIN_SEATS,
      description: enterprise.tagline,
    },
    // Full catalog for the Plans page: every plan's copy, features, limits and entitlements.
    plans: catalog.filter((p) => p.active).map((p) => ({ ...p, annualPricePaise: annualPricePaise(p) })),
    packages: packages.map((pkg) => ({
      id: pkg.id as string,
      name: pkg.name as string,
      description: pkg.description as string,
      target: pkg.target as "individual" | "organization",
      plan: pkg.plan as string,
      pricePaise: Number(pkg.price_paise),
      currency: pkg.currency as string,
      durationDays: pkg.duration_days as number | null,
      monthlyTokenCap: pkg.monthly_token_cap as number | null,
      seats: pkg.seats as number | null,
      features: (pkg.features as string[]) ?? [],
      entitlements: pkg.entitlements ?? {},
      badge: (pkg.badge as string | null) ?? null,
      highlight: Boolean(pkg.highlight),
    })),
  };
}

export type CreateOrderInput = {
  planId: OrderPlanId;
  billingCycle: BillingCycle;
  /** Required (and >= ENTERPRISE_PLAN.minSeats) for planId "enterprise"; ignored otherwise. */
  seats?: number;
  /** The org this enterprise purchase applies to — the user must already own/admin it (created
   *  via the existing self-serve /organizations flow) before checkout can start. */
  organizationId?: string;
  /** A discount offer code (Team Console → Plans & Offers); validated and applied server-side. */
  offerCode?: string;
  /** planId "package": the public package being bought (priced from the package row, never the client). */
  packageId?: string;
};

export async function createRazorpayOrder(userId: string, input: CreateOrderInput) {
  requireRazorpayConfigured();
  const receipt = `friday_${Date.now()}_${userId.slice(0, 8)}`;

  let amountPaise: number;
  let name: string;
  let description: string;
  let seats: number | null = null;

  if (input.planId === "package") {
    if (!input.packageId) throw new HttpError(400, "packageId is required");
    const { data: pkg } = await supabaseAdmin.from("plan_packages").select("*").eq("id", input.packageId).eq("active", true).eq("public", true).maybeSingle();
    if (!pkg) throw new HttpError(404, "That package isn't available");
    if (pkg.target === "organization") {
      if (!input.organizationId) throw new HttpError(400, "Choose the team this package is for");
      await requireOrgRole(userId, input.organizationId, ["owner", "admin"]);
    }
    amountPaise = Number(pkg.price_paise);
    name = pkg.name as string;
    description = pkg.duration_days ? `${pkg.duration_days} days` : "Package";
  } else if (input.planId === "enterprise") {
    if (!input.organizationId) throw new HttpError(400, "organizationId is required for an Enterprise purchase");
    // Without this, any authenticated user could pass an arbitrary organizationId and buy/
    // upgrade seats on an org they don't own — the webhook grant trusts whatever org the order
    // was created against, so authorization has to happen here, before the order even exists.
    await requireOrgRole(userId, input.organizationId, ["owner", "admin"]);
    const enterprise = await getCatalogPlan("enterprise");
    const minSeats = enterprise.minSeats ?? ENTERPRISE_MIN_SEATS;
    seats = Math.max(minSeats, Math.floor(input.seats ?? minSeats));
    amountPaise = cycleAmount(enterprise, input.billingCycle) * seats;
    name = `Friday ${enterprise.name}`;
    description = `${seats} seats, ${input.billingCycle}`;
  } else {
    const plan = await getCatalogPlan(input.planId);
    if (!plan.active || plan.monthlyPricePaise <= 0) throw new HttpError(400, "That plan isn't available for purchase");
    amountPaise = cycleAmount(plan, input.billingCycle);
    name = `Friday ${plan.name}`;
    description = plan.tagline;
  }

  // The discount is computed here, never trusted from the client; the use is only recorded once the
  // payment webhook confirms the order was paid.
  let discount: { offerId: string; percent: number } | null = null;
  if (input.offerCode?.trim()) {
    discount = await discountForCheckout(userId, input.offerCode, input.planId === "package" ? `package:${input.packageId}` : input.planId);
    amountPaise = Math.max(100, Math.round((amountPaise * (100 - discount.percent)) / 100));
    description = `${description} · ${discount.percent}% off`;
  }

  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt,
      notes: {
        user_id: userId,
        plan: input.planId,
        organization_id: input.organizationId ?? "",
      },
    }),
  });

  const body = (await response.json().catch(() => null)) as { id?: string; error?: { description?: string } } | null;
  if (!response.ok || !body?.id) {
    throw new HttpError(response.status || 502, body?.error?.description ?? "Failed to create Razorpay order");
  }

  const { data, error } = await supabaseAdmin
    .from("razorpay_orders")
    .insert({
      user_id: userId,
      organization_id: input.organizationId ?? null,
      plan: input.planId,
      amount_paise: amountPaise,
      currency: "INR",
      razorpay_order_id: body.id,
      metadata: { receipt, billingCycle: input.billingCycle, seats, ...(input.planId === "package" ? { packageId: input.packageId } : {}), ...(discount ? { offerId: discount.offerId, discountPercent: discount.percent } : {}) },
    })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to save billing order");

  return {
    order: data,
    checkout: {
      key: env.razorpayKeyId,
      orderId: body.id,
      amount: amountPaise,
      currency: "INR",
      name: "Friday AI",
      description: `${name} — ${description}`,
    },
  };
}

/**
 * The signed-in user's own order history — the Billing settings pane's "Invoices" list. Only
 * `paid` (and `failed`, so a declined payment isn't silently invisible) rows qualify as an
 * actual invoice — a bare `created` row just means checkout was opened and abandoned (closed the
 * Razorpay popup, never finished paying), which isn't a billing event and shouldn't clutter a
 * list whose whole point is "what did I actually pay."
 */
export async function listMyOrders(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("razorpay_orders")
    .select("id, plan, amount_paise, currency, status, metadata, created_at")
    .eq("user_id", userId)
    .in("status", ["paid", "failed"])
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    plan: row.plan as string,
    amountPaise: row.amount_paise as number,
    currency: row.currency as string,
    status: row.status as string,
    billingCycle: ((row.metadata as { billingCycle?: string } | null)?.billingCycle ?? "monthly") as string,
    createdAt: row.created_at as string,
  }));
}

export function verifyRazorpayWebhook(rawBody: Buffer, signature: string | undefined): boolean {
  if (!env.razorpayWebhookSecret || !signature) return false;
  const expected = createHmac("sha256", env.razorpayWebhookSecret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

type PaymentEntity = { id?: unknown; order_id?: unknown; error_description?: unknown };
type RefundEntity = { id?: unknown; payment_id?: unknown; amount?: unknown };

/**
 * Razorpay → plans. Everything that changes what someone can use runs through an idempotent SQL
 * function keyed on the order (supabase 0057): a webhook Razorpay retries, or delivers twice, can
 * never extend a term twice or hand out a second allowance. A failure here throws, so the webhook
 * answers 5xx and Razorpay retries it.
 *
 *   payment.captured / order.paid      → quota_apply_payment (renewal / new term / upgrade / queued downgrade)
 *   payment.failed                     → order marked failed (never a paid one), event logged; nothing is taken away
 *   refund.processed / payment.refunded→ quota_apply_refund (the refunded months come off the term)
 */
export async function handleRazorpayWebhook(payload: Record<string, unknown>) {
  const eventType = typeof payload.event === "string" ? payload.event : "unknown";
  const eventId = typeof payload.id === "string" ? payload.id : null;

  if (eventId) {
    const { error: eventError } = await supabaseAdmin.from("billing_webhook_events").insert({
      provider: "razorpay",
      provider_event_id: eventId,
      event_type: eventType,
      payload,
    });
    if (eventError && eventError.code !== "23505") logger.warn("razorpay_webhook_event_log_failed", { eventError });
  }

  const entities = payload.payload as { payment?: { entity?: PaymentEntity }; refund?: { entity?: RefundEntity } } | undefined;
  const paymentEntity = entities?.payment?.entity;
  const refundEntity = entities?.refund?.entity;
  const paymentId = typeof paymentEntity?.id === "string" ? paymentEntity.id : typeof refundEntity?.payment_id === "string" ? refundEntity.payment_id : null;
  let orderId = typeof paymentEntity?.order_id === "string" ? paymentEntity.order_id : null;

  const paid = eventType === "payment.captured" || eventType === "order.paid";
  const failed = eventType === "payment.failed";
  const refunded = eventType === "refund.processed" || eventType === "payment.refunded";
  if (!paid && !failed && !refunded) return;

  if (!orderId && paymentId) {
    const { data } = await supabaseAdmin.from("razorpay_orders").select("razorpay_order_id").eq("razorpay_payment_id", paymentId).maybeSingle();
    orderId = (data?.razorpay_order_id as string | undefined) ?? null;
  }
  if (!orderId) return;

  const { data: order, error } = await supabaseAdmin
    .from("razorpay_orders")
    .select("user_id, organization_id, plan, metadata, status")
    .eq("razorpay_order_id", orderId)
    .maybeSingle();
  if (error) throw new Error(`razorpay order lookup failed: ${error.message}`);
  if (!order?.user_id) return;
  const metadata = (order.metadata as { billingCycle?: BillingCycle; seats?: number; offerId?: string; packageId?: string } | null) ?? {};
  // Terms are calendar months (supabase 0057): a term then ends exactly where an allowance period ends.
  const months = metadata.billingCycle === "annual" ? 12 : 1;
  const plan = order.plan === "business" ? "premium" : (order.plan as string); // "business" is a pre-0016 legacy id

  if (failed) {
    // An order can collect failed attempts before (or even after) the one that succeeds — a late
    // failure must never flip a paid order back.
    await supabaseAdmin.from("razorpay_orders").update({ status: "failed", updated_at: new Date().toISOString() }).eq("razorpay_order_id", orderId).neq("status", "paid");
    await supabaseAdmin.from("subscription_events").insert({
      user_id: order.user_id,
      organization_id: order.organization_id,
      kind: "payment_failed",
      plan,
      order_id: orderId,
      idempotency_key: `payment_failed:${paymentId ?? orderId}`,
      details: { reason: typeof paymentEntity?.error_description === "string" ? paymentEntity.error_description.slice(0, 300) : null },
    }).then(({ error: e }) => {
      if (e && e.code !== "23505") logger.warn("subscription_event_failed", { orderId, error: e.message });
    });
    return;
  }

  if (refunded) {
    if (plan === "pro" || plan === "premium") {
      const { error: refundError } = await supabaseAdmin.rpc("quota_apply_refund", { p_user: order.user_id, p_plan: plan, p_months: months, p_order: orderId });
      if (refundError) throw new Error(`refund apply failed: ${refundError.message}`);
    } else {
      await supabaseAdmin.from("subscription_events").insert({ user_id: order.user_id, organization_id: order.organization_id, kind: "refund", plan, order_id: orderId, idempotency_key: `refund:${orderId}` });
    }
    return;
  }

  // Paid. Marking the order is idempotent; granting is keyed on the order inside SQL.
  const { error: updateError } = await supabaseAdmin
    .from("razorpay_orders")
    .update({ status: "paid", razorpay_payment_id: paymentId, updated_at: new Date().toISOString() })
    .eq("razorpay_order_id", orderId);
  if (updateError) throw new Error(`razorpay order update failed: ${updateError.message}`);
  if (metadata.offerId && order.status !== "paid") await recordDiscountUse(metadata.offerId, order.user_id as string, orderId).catch(() => {});

  if (plan === "package" && metadata.packageId) {
    // Once per order: the package's own duration/limits/entitlements apply, recorded as an access grant.
    const { error: dup } = await supabaseAdmin.from("subscription_events").insert({
      user_id: order.user_id,
      organization_id: order.organization_id,
      kind: "package",
      plan: "package",
      order_id: orderId,
      idempotency_key: `payment:${orderId}`,
      details: { packageId: metadata.packageId },
    });
    if (dup) {
      if (dup.code === "23505") return; // already applied
      throw new Error(`package event failed: ${dup.message}`);
    }
    await applyPackage(
      metadata.packageId,
      order.organization_id ? { organizationId: order.organization_id as string } : { userId: order.user_id as string },
      `Purchased (order ${orderId})`,
      null,
    );
    return;
  }

  if (plan === "pro" || plan === "premium") {
    // Prices let an upgrade credit the old plan's unused time at the price ratio.
    const [pro, premium] = await Promise.all([getCatalogPlan("pro"), getCatalogPlan("premium")]);
    const { error: applyError } = await supabaseAdmin.rpc("quota_apply_payment", {
      p_user: order.user_id,
      p_plan: plan,
      p_months: months,
      p_order: orderId,
      p_prices: { pro: pro.monthlyPricePaise, premium: premium.monthlyPricePaise },
    });
    if (applyError) throw new Error(`plan grant failed: ${applyError.message}`);
    resolveEffectivePlan.invalidate(order.user_id as string);
    return;
  }

  if (plan === "enterprise" && order.organization_id) {
    const enterprise = await getCatalogPlan("enterprise");
    const seats = Math.max(enterprise.minSeats ?? ENTERPRISE_PLAN.minSeats, metadata.seats ?? ENTERPRISE_PLAN.minSeats);
    const { error: orgError } = await supabaseAdmin.rpc("quota_apply_org_payment", { p_org: order.organization_id, p_user: order.user_id, p_seats: seats, p_order: orderId });
    if (orgError) throw new Error(`enterprise grant failed: ${orgError.message}`);
  }
}
