import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { savePassphrase } from "../services/air/passphrase.js";
import { acceptChannelMessage, airScreen, endCall, linkChannel, openCall, type AirChannel } from "../services/air/doors.js";

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
