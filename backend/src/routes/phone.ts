import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { endPhoneCall, handlePhoneTurn } from "../services/phone/runtime.js";
import { getUserPhoneSettings, hydrateUserPhone, listPresence, registerPresence, setUserPhoneSettings } from "../services/phone/store.js";
import type { DeliveryChannel } from "../services/phone/policy.js";

export const phoneRouter = Router();

function sameSecret(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertGateway(req: { header(name: string): string | undefined }) {
  const expected = process.env.PHONE_GATEWAY_SECRET ?? "";
  if (!expected) throw new HttpError(503, "The phone gateway secret is not set yet.");
  const given = req.header("x-friday-phone-secret") ?? "";
  if (!sameSecret(given, expected)) throw new HttpError(401, "Unknown caller.");
}

const turnBody = z.object({
  from: z.string().optional(),
  From: z.string().optional(),
  text: z.string().optional(),
  transcript: z.string().optional(),
  SpeechResult: z.string().optional(),
  sessionId: z.string().optional(),
  CallSid: z.string().optional(),
});

/** Sarvam and Exotel both land here. Audio stays on their side. Friday only sees the words. */
phoneRouter.post(
  "/turn",
  asyncHandler(async (req, res) => {
    assertGateway(req);
    const body = turnBody.parse(req.body ?? {});
    const from = body.from ?? body.From ?? "";
    const text = (body.text ?? body.transcript ?? body.SpeechResult ?? "").trim();
    if (!text) throw new HttpError(400, "Empty turn.");
    const result = await handlePhoneTurn(from, text, body.sessionId ?? body.CallSid);
    res.json({
      sessionId: result.sessionId,
      action: result.action,
      speak: result.speak,
      hold: result.hold,
      jobId: result.jobId,
      conversationId: result.conversationId,
      delivery: result.delivery,
    });
  }),
);

phoneRouter.post(
  "/end",
  asyncHandler(async (req, res) => {
    assertGateway(req);
    const body = z.object({
      sessionId: z.string().optional(),
      CallSid: z.string().optional(),
      seconds: z.number().optional(),
      Duration: z.coerce.number().optional(),
    }).parse(req.body ?? {});
    const sessionId = body.sessionId ?? body.CallSid;
    if (!sessionId) throw new HttpError(400, "Missing call id.");
    res.json(await endPhoneCall(sessionId, body.seconds ?? body.Duration ?? 0));
  }),
);

phoneRouter.use(requireAuth);

phoneRouter.post(
  "/presence",
  asyncHandler(async (req, res) => {
    const body = z.object({ kind: z.enum(["web", "cli", "sandbox", "call"]), id: z.string().max(80).optional() }).parse(req.body ?? {});
    registerPresence(req.user!.id, body.kind, body.id);
    res.json({ online: listPresence(req.user!.id) });
  }),
);

phoneRouter.get(
  "/presence",
  asyncHandler(async (req, res) => {
    res.json({ online: listPresence(req.user!.id) });
  }),
);

phoneRouter.get(
  "/settings",
  asyncHandler(async (req, res) => {
    await hydrateUserPhone(req.user!.id);
    res.json(getUserPhoneSettings(req.user!.id));
  }),
);

phoneRouter.put(
  "/settings",
  asyncHandler(async (req, res) => {
    const body = z.object({
      channels: z.array(z.enum(["call", "app", "telegram", "whatsapp", "email"])).max(5),
      callback: z.boolean(),
      quietStart: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
      quietEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
      language: z.string().min(2).max(12),
    }).parse(req.body);
    setUserPhoneSettings(req.user!.id, { ...body, channels: body.channels as DeliveryChannel[] });
    res.json(getUserPhoneSettings(req.user!.id));
  }),
);
