import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import {
  createRazorpayOrder,
  handleRazorpayWebhook,
  listMyOrders,
  publicBillingConfig,
  verifyRazorpayWebhook,
} from "../services/billingService.js";

export const billingRouter = Router();

const createOrderSchema = z.object({
  planId: z.enum(["pro", "premium", "enterprise"]),
  billingCycle: z.enum(["monthly", "annual"]).default("monthly"),
  seats: z.number().int().min(1).max(10_000).optional(),
  organizationId: z.string().uuid().optional(),
  offerCode: z.string().trim().max(40).optional(),
});

billingRouter.post(
  "/razorpay/webhook",
  asyncHandler(async (req, res) => {
    if (!verifyRazorpayWebhook(req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})), req.header("x-razorpay-signature"))) {
      throw new HttpError(401, "Invalid Razorpay webhook signature");
    }
    await handleRazorpayWebhook(req.body as Record<string, unknown>);
    res.json({ ok: true });
  }),
);

// Public on purpose — pricing/plan metadata (see publicBillingConfig, same spirit as GET
// /models) is exactly what a signed-out visitor deciding whether to sign up needs to see, and
// gating it behind requireAuth meant the /upgrade page's prices silently disappeared (staying
// stuck at their ₹0 default) for anyone whose session token happened to be stale or absent —
// only the public /models call would succeed, making it look like just the models were missing.
billingRouter.get(
  "/config",
  asyncHandler(async (_req, res) => {
    res.json(publicBillingConfig());
  }),
);

billingRouter.use(requireAuth);

billingRouter.post(
  "/orders",
  asyncHandler(async (req, res) => {
    const input = createOrderSchema.parse(req.body);
    res.status(201).json(await createRazorpayOrder(req.user!.id, input));
  }),
);

billingRouter.get(
  "/orders",
  asyncHandler(async (req, res) => {
    res.json({ orders: await listMyOrders(req.user!.id) });
  }),
);
