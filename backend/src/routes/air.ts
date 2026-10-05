import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { savePassphrase } from "../services/air/passphrase.js";
import { acceptChannelMessage, airScreen, askForLogin, callAllowance, dropOnScreen, endCall, linkChannel, openCall, tickCall, type AirChannel } from "../services/air/doors.js";
import { runAirJob } from "../services/air/jobs.js";

export const airRouter = Router();

function sameSecret(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function channelHook(channel: AirChannel) {
  return asyncHandler(async (req, res) => {
    const expected = process.env.AIR_CHANNEL_SECRET ?? "";
    if (!expected) throw new HttpError(503, "The channel door is not configured.");
    const given = req.header("x-friday-channel-secret") ?? "";
    if (!sameSecret(given, expected)) throw new HttpError(401, "Unknown caller.");
    const body = z.object({ externalId: z.string().min(1).max(80), text: z.string().min(1).max(8000) }).parse(req.body);
    res.status(202).json(await acceptChannelMessage(channel, body.externalId, body.text));
  });
}

airRouter.post("/hooks/whatsapp", channelHook("whatsapp"));
airRouter.post("/hooks/telegram", channelHook("telegram"));

airRouter.use(requireAuth);

airRouter.put(
  "/passphrase",
  asyncHandler(async (req, res) => {
    const body = z.object({ phrase: z.string() }).parse(req.body);
    await savePassphrase(req.user!.id, body.phrase);
    res.json({ ok: true });
  }),
);

airRouter.post(
  "/channels",
  asyncHandler(async (req, res) => {
    const body = z.object({ channel: z.enum(["whatsapp", "telegram"]), externalId: z.string() }).parse(req.body);
    res.status(201).json(await linkChannel(req.user!.id, body.channel, body.externalId));
  }),
);

airRouter.post(
  "/calls",
  asyncHandler(async (req, res) => {
    const body = z.object({ conversationId: z.string().uuid().optional() }).parse(req.body ?? {});
    res.status(201).json(await openCall(req.user!.id, body.conversationId));
  }),
);

airRouter.get(
  "/minutes",
  asyncHandler(async (req, res) => {
    res.json(await callAllowance(req.user!.id));
  }),
);

airRouter.post(
  "/jobs",
  asyncHandler(async (req, res) => {
    const body = z.object({ conversationId: z.string().uuid(), task: z.string().min(1).max(8000).optional() }).parse(req.body);
    res.status(202).json(await runAirJob(req.user!.id, body.conversationId, body.task ?? "Continue until this is done. If you are blocked, say so and stop."));
  }),
);

airRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = z.object({ conversationId: z.string().uuid(), reason: z.string().min(1).max(500), urgent: z.boolean().optional() }).parse(req.body);
    res.status(202).json(await askForLogin(req.user!.id, body.conversationId, body.reason, Boolean(body.urgent)));
  }),
);

airRouter.post(
  "/calls/:id/tick",
  asyncHandler(async (req, res) => {
    const body = z.object({ seconds: z.number().int().min(1).max(60) }).parse(req.body);
    res.json(await tickCall(req.user!.id, req.params.id!, body.seconds));
  }),
);

airRouter.post(
  "/calls/:id/end",
  asyncHandler(async (req, res) => {
    await endCall(req.user!.id, req.params.id!);
    res.json({ ok: true });
  }),
);

airRouter.get(
  "/screen/:conversationId",
  asyncHandler(async (req, res) => {
    res.json(await airScreen(req.user!.id, req.params.conversationId!));
  }),
);

airRouter.post(
  "/screen/:conversationId/drop",
  asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().min(1).max(80), content: z.string().max(200_000) }).parse(req.body);
    res.status(201).json(await dropOnScreen(req.user!.id, req.params.conversationId!, body.name, body.content));
  }),
);
