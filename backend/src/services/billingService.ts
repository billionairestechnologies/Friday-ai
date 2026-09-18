import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { logger } from "../utils/logger.js";
import { ENTERPRISE_MIN_SEATS, ENTERPRISE_TOKENS_PER_SEAT } from "./quota/tierConfig.js";

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
// longer period, same as a monthly one is for 30 days.
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
  description: `Pooled org-wide tokens (${(ENTERPRISE_TOKENS_PER_SEAT / 1_000_000).toFixed(0)}M/seat/mo), no 5-hour lockout, every model.`,
} as const;

type OrderPlanId = "pro" | "premium" | "enterprise";

function requireRazorpayConfigured() {
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    throw new HttpError(503, "Razorpay billing is not configured yet");
  }
}

export function publicBillingConfig() {
  return {
    provider: "razorpay",
    keyId: env.razorpayKeyId || null,
    currency: "INR",
    annualDiscountPercent: 10,
    individual: INDIVIDUAL_PLANS.map((p) => ({
      ...p,
      annualAmountPaise: annualAmountPaise(p.monthlyAmountPaise),
    })),
    enterprise: ENTERPRISE_PLAN,
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
};

export async function createRazorpayOrder(userId: string, input: CreateOrderInput) {
  requireRazorpayConfigured();
  const receipt = `friday_${Date.now()}_${userId.slice(0, 8)}`;

  let amountPaise: number;
  let name: string;
  let description: string;
  let seats: number | null = null;

  if (input.planId === "enterprise") {
    if (!input.organizationId) throw new HttpError(400, "organizationId is required for an Enterprise purchase");
    seats = Math.max(ENTERPRISE_PLAN.minSeats, Math.floor(input.seats ?? ENTERPRISE_PLAN.minSeats));
    const perSeatForCycle = amountForCycle(ENTERPRISE_PLAN.perSeatMonthlyAmountPaise, input.billingCycle);
    amountPaise = perSeatForCycle * seats;
    name = ENTERPRISE_PLAN.name;
    description = `${seats} seats, ${input.billingCycle}`;
  } else {
    const plan = INDIVIDUAL_PLANS.find((p) => p.id === input.planId);
    if (!plan) throw new HttpError(400, "Unknown billing plan");
    amountPaise = amountForCycle(plan.monthlyAmountPaise, input.billingCycle);
    name = plan.name;
    description = plan.description;
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
      metadata: { receipt, billingCycle: input.billingCycle, seats },
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

export function verifyRazorpayWebhook(rawBody: Buffer, signature: string | undefined): boolean {
  if (!env.razorpayWebhookSecret || !signature) return false;
  const expected = createHmac("sha256", env.razorpayWebhookSecret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

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

  const paymentEntity = (payload.payload as { payment?: { entity?: Record<string, unknown> } } | undefined)?.payment
    ?.entity;
  const orderId = typeof paymentEntity?.order_id === "string" ? paymentEntity.order_id : null;
  const paymentId = typeof paymentEntity?.id === "string" ? paymentEntity.id : null;
  if (!orderId) return;

  const paid = eventType === "payment.captured" || eventType === "order.paid";
  const failed = eventType === "payment.failed";
  if (!paid && !failed) return;

  const { data: order, error } = await supabaseAdmin
    .from("razorpay_orders")
    .update({
      status: paid ? "paid" : "failed",
      razorpay_payment_id: paymentId,
      updated_at: new Date().toISOString(),
    })
    .eq("razorpay_order_id", orderId)
    .select("user_id, organization_id, plan, metadata")
    .maybeSingle();
  if (error) {
    logger.warn("razorpay_order_update_failed", { orderId, error: error.message });
    return;
  }
  if (!paid || !order?.user_id) return;

  // This is the ONLY place a payment actually grants anything — without it, paying just marks
  // the order row "paid" with no effect on the user's actual limits.
  const metadata = (order.metadata as { billingCycle?: BillingCycle; seats?: number } | null) ?? {};
  const renewsInDays = metadata.billingCycle === "annual" ? 365 : 30;
  const renewsAt = new Date(Date.now() + renewsInDays * 24 * 60 * 60 * 1000).toISOString();

  if (order.plan === "pro" || order.plan === "premium" || order.plan === "business") {
    // "business" is a pre-migration legacy id (see 0016) — treated as premium going forward.
    const plan = order.plan === "business" ? "premium" : order.plan;
    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .update({ plan, plan_renews_at: renewsAt })
      .eq("id", order.user_id);
    if (profileError) logger.warn("razorpay_plan_grant_failed", { orderId, error: profileError.message });
    return;
  }

  if (order.plan === "enterprise" && order.organization_id) {
    const seats = Math.max(ENTERPRISE_PLAN.minSeats, metadata.seats ?? ENTERPRISE_PLAN.minSeats);
    const { error: orgError } = await supabaseAdmin
      .from("organizations")
      .update({
        plan: "enterprise",
        seat_count: seats,
        pooled_monthly_tokens: seats * ENTERPRISE_TOKENS_PER_SEAT,
        billing_cycle_anchor: new Date().toISOString(),
      })
      .eq("id", order.organization_id);
    if (orgError) logger.warn("razorpay_enterprise_grant_failed", { orderId, error: orgError.message });
  }
}
