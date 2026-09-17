import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { logger } from "../utils/logger.js";

export const BILLING_PLANS = [
  {
    id: "pro",
    name: "Friday Pro",
    amountPaise: 99900,
    currency: "INR",
    description: "Higher personal limits for chat, search, voice, and Canvas.",
  },
  {
    id: "business",
    name: "Friday Business",
    amountPaise: 299900,
    currency: "INR",
    description: "Team workspace foundation with admin budgets and audit logs.",
  },
] as const;

type PlanId = (typeof BILLING_PLANS)[number]["id"];

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
    plans: BILLING_PLANS,
  };
}

export function getPlan(planId: string) {
  const plan = BILLING_PLANS.find((item) => item.id === planId);
  if (!plan) throw new HttpError(400, "Unknown billing plan");
  return plan;
}

export async function createRazorpayOrder(userId: string, planId: PlanId, organizationId?: string | null) {
  requireRazorpayConfigured();
  const plan = getPlan(planId);
  const receipt = `friday_${Date.now()}_${userId.slice(0, 8)}`;

  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: plan.amountPaise,
      currency: plan.currency,
      receipt,
      notes: {
        user_id: userId,
        plan: plan.id,
        organization_id: organizationId ?? "",
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
      organization_id: organizationId ?? null,
      plan: plan.id,
      amount_paise: plan.amountPaise,
      currency: plan.currency,
      razorpay_order_id: body.id,
      metadata: { receipt },
    })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to save billing order");

  return {
    order: data,
    checkout: {
      key: env.razorpayKeyId,
      orderId: body.id,
      amount: plan.amountPaise,
      currency: plan.currency,
      name: "Friday AI",
      description: plan.name,
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

  await supabaseAdmin
    .from("razorpay_orders")
    .update({
      status: paid ? "paid" : "failed",
      razorpay_payment_id: paymentId,
      updated_at: new Date().toISOString(),
    })
    .eq("razorpay_order_id", orderId);
}
