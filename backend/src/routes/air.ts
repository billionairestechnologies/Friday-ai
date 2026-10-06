import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { getOwnedConversation } from "../services/chat/conversations.js";
import { hasPassphrase, savePassphrase, assertPassphrase } from "../services/air/passphrase.js";
import {
  acceptChannelMessage,
  approveFromWeb,
  callAllowance,
  continueAfterLogin,
  endCall,
  linkChannel,
  listCalls,
  listChannels,
  openCall,
  tickCall,
  unlinkChannel,
  type AirChannel,
} from "../services/air/doors.js";
import { latestJob, startAirJob, stopAirJob } from "../services/air/jobs.js";
import { recentActions } from "../services/air/gate.js";
import { dropOnScreen, getScreen, screenInput } from "../services/air/screen.js";
import { readTelegramUpdate, readWhatsAppWebhook, telegramLinkUrl, verifyWhatsAppSubscription } from "../services/air/channels.js";

export const airRouter = Router();

function sameSecret(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Generic door for a relay that already speaks Friday's shape ({externalId, text}). */
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

// Native webhooks: Meta's WhatsApp Cloud API and Telegram's Bot API post here directly.
airRouter.get("/hooks/whatsapp/meta", (req, res) => {
  const challenge = verifyWhatsAppSubscription(req.query as Record<string, unknown>);
  if (challenge == null) {
    res.status(403).end();
    return;
  }
  res.type("text/plain").send(challenge);
});
airRouter.post(
  "/hooks/whatsapp/meta",
  asyncHandler(async (req, res) => {
    const messages = readWhatsAppWebhook(req.body, req.header("x-hub-signature-256"), (req as { rawBody?: Buffer }).rawBody);
    // Meta retries anything that isn't a fast 200; the work continues in the background.
    res.status(200).json({ ok: true });
    for (const m of messages) void acceptChannelMessage("whatsapp", m.from, m.text).catch(() => undefined);
  }),
);
airRouter.post(
  "/hooks/telegram/:secret",
  asyncHandler(async (req, res) => {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    if (!expected || !sameSecret(String(req.params.secret ?? ""), expected)) throw new HttpError(401, "Unknown caller.");
    const update = readTelegramUpdate(req.body);
    res.status(200).json({ ok: true });
    if (update) void acceptChannelMessage("telegram", update.chatId, update.text).catch(() => undefined);
  }),
);

airRouter.use(requireAuth);

// ── Passphrase ──────────────────────────────────────────────────────────────
airRouter.get(
  "/passphrase",
  asyncHandler(async (req, res) => {
    res.json({ set: await hasPassphrase(req.user!.id) });
  }),
);
airRouter.put(
  "/passphrase",
  rateLimit({ name: "air-passphrase", limit: 10, windowMs: 15 * 60_000 }),
  asyncHandler(async (req, res) => {
    const body = z.object({ phrase: z.string(), current: z.string().optional() }).parse(req.body);
    // Changing an existing passphrase needs the current one (same rule as on the phone).
    if (await hasPassphrase(req.user!.id)) await assertPassphrase(req.user!.id, body.current);
    await savePassphrase(req.user!.id, body.phrase);
    res.json({ ok: true });
  }),
);

// ── Channels ────────────────────────────────────────────────────────────────
airRouter.get(
  "/channels",
  asyncHandler(async (req, res) => {
    res.json({ channels: await listChannels(req.user!.id), telegramLink: telegramLinkUrl(req.user!.id) });
  }),
);
airRouter.post(
  "/channels",
  asyncHandler(async (req, res) => {
    const body = z.object({ channel: z.enum(["whatsapp", "telegram"]), externalId: z.string() }).parse(req.body);
    res.status(201).json(await linkChannel(req.user!.id, body.channel, body.externalId));
  }),
);
airRouter.delete(
  "/channels/:channel",
  asyncHandler(async (req, res) => {
    const channel = z.enum(["whatsapp", "telegram"]).parse(req.params.channel);
    await unlinkChannel(req.user!.id, channel);
    res.status(204).end();
  }),
);

// ── Jobs ────────────────────────────────────────────────────────────────────
airRouter.post(
  "/jobs",
  asyncHandler(async (req, res) => {
    const body = z.object({ conversationId: z.string().uuid(), task: z.string().min(1).max(8000).optional(), urgent: z.boolean().optional() }).parse(req.body);
    await getOwnedConversation(req.user!.id, body.conversationId);
    const started = await startAirJob(req.user!.id, body.conversationId, body.task ?? "Continue until this is done.", { source: "web", urgent: body.urgent });
    res.status(202).json(started);
  }),
);
airRouter.get(
  "/jobs/:conversationId",
  asyncHandler(async (req, res) => {
    await getOwnedConversation(req.user!.id, req.params.conversationId!);
    res.json({ job: await latestJob(req.user!.id, req.params.conversationId!) });
  }),
);
airRouter.post(
  "/jobs/:conversationId/stop",
  asyncHandler(async (req, res) => {
    res.json(await stopAirJob(req.user!.id, req.params.conversationId!));
  }),
);
airRouter.post(
  "/jobs/:conversationId/approve",
  rateLimit({ name: "air-approve", limit: 10, windowMs: 15 * 60_000 }),
  asyncHandler(async (req, res) => {
    const body = z.object({ passphrase: z.string().max(80).optional() }).parse(req.body ?? {});
    await getOwnedConversation(req.user!.id, req.params.conversationId!);
    res.json(await approveFromWeb(req.user!.id, req.params.conversationId!, body.passphrase));
  }),
);
airRouter.post(
  "/jobs/:conversationId/signed-in",
  asyncHandler(async (req, res) => {
    await getOwnedConversation(req.user!.id, req.params.conversationId!);
    res.json(await continueAfterLogin(req.user!.id, req.params.conversationId!));
  }),
);
airRouter.get(
  "/actions/:conversationId",
  asyncHandler(async (req, res) => {
    res.json({ actions: await recentActions(req.user!.id, req.params.conversationId!) });
  }),
);

// ── Calls ───────────────────────────────────────────────────────────────────
airRouter.get(
  "/minutes",
  asyncHandler(async (req, res) => {
    res.json(await callAllowance(req.user!.id));
  }),
);
airRouter.get(
  "/calls",
  asyncHandler(async (req, res) => {
    res.json({ calls: await listCalls(req.user!.id) });
  }),
);
airRouter.post(
  "/calls",
  rateLimit({ name: "air-call", limit: 10, windowMs: 10 * 60_000 }),
  asyncHandler(async (req, res) => {
    const body = z.object({ conversationId: z.string().uuid().optional() }).parse(req.body ?? {});
    if (body.conversationId) await getOwnedConversation(req.user!.id, body.conversationId);
    res.status(201).json(await openCall(req.user!.id, body.conversationId));
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

// ── Screen ──────────────────────────────────────────────────────────────────
airRouter.get(
  "/screen/:conversationId",
  asyncHandler(async (req, res) => {
    res.json(await getScreen(req.user!.id, req.params.conversationId!));
  }),
);
const screenInputBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("type"), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("key"), key: z.string().min(1).max(20) }),
  z.object({ type: z.literal("scroll"), direction: z.enum(["up", "down"]) }),
  z.object({ type: z.literal("open"), url: z.string().url().max(2000) }),
  z.object({ type: z.literal("back") }),
]);
airRouter.post(
  "/screen/:conversationId/input",
  rateLimit({ name: "air-screen", limit: 240, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    res.json(await screenInput(req.user!.id, req.params.conversationId!, screenInputBody.parse(req.body)));
  }),
);
airRouter.post(
  "/screen/:conversationId/drop",
  asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().min(1).max(80), content: z.string().max(200_000) }).parse(req.body);
    res.status(201).json(await dropOnScreen(req.user!.id, req.params.conversationId!, body.name, body.content));
  }),
);
