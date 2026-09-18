import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import {
  createRazorpayOrder,
  handleRazorpayWebhook,
  publicBillingConfig,
  verifyRazorpayWebhook,
} from "../services/billingService.js";

export const billingRouter = Router();

const createOrderSchema = z.object({
  planId: z.enum(["pro", "premium", "enterprise"]),
  billingCycle: z.enum(["monthly", "annual"]).default("monthly"),
  seats: z.number().int().min(1).max(10_000).optional(),
  organizationId: z.string().uuid().optional(),
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

billingRouter.use(requireAuth);

billingRouter.get(
  "/config",
  asyncHandler(async (_req, res) => {
    res.json(publicBillingConfig());
  }),
);

billingRouter.post(
  "/orders",
  asyncHandler(async (req, res) => {
    const input = createOrderSchema.parse(req.body);
    res.status(201).json(await createRazorpayOrder(req.user!.id, input));
  }),
);
