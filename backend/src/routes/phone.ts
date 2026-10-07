import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { endPhoneCall, handlePhoneTurn } from "../services/phone/runtime.js";
import { answerTrunk, pickUp, samePathSecret, type TrunkName } from "../services/phone/trunk.js";
import { liveSession } from "../services/phone/live.js";
import { transcribeAudio, synthesizeSpeech } from "../services/voiceService.js";
import { getPhoneConfig, getUserPhoneSettings, listPresence, loadPhoneConfig, registerPresence, setUserPhoneSettings } from "../services/phone/store.js";
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

function publicTurn(result: { sessionId: string; action: string; speak: string; hold: boolean; jobId: string | null; conversationId: string | null; delivery: string[] }) {
  return {
    sessionId: result.sessionId,
    action: result.action,
    speak: result.speak,
    hold: result.hold,
    jobId: result.jobId,
    conversationId: result.conversationId,
    delivery: result.delivery,
  };
}

const turnBody = z.object({
  from: z.string().optional(),
  From: z.string().optional(),
  text: z.string().optional(),
  transcript: z.string().optional(),
  SpeechResult: z.string().optional(),
  sessionId: z.string().optional(),
  CallSid: z.string().optional(),
  trunk: z.string().max(20).optional(),
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
    const result = await handlePhoneTurn(from, text, body.sessionId ?? body.CallSid, undefined, body.trunk ?? "pipecat");
    res.json(publicTurn(result));
  }),
);

/** The voice bridge picked up a call: who is it, and what does Friday say first? */
phoneRouter.post(
  "/answer",
  asyncHandler(async (req, res) => {
    assertGateway(req);
    const body = z.object({ from: z.string().max(40), to: z.string().max(40).default(""), sessionId: z.string().min(1).max(120), trunk: z.string().max(20).default("pipecat") }).parse(req.body ?? {});
    res.json(await pickUp(body.trunk, body));
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

function trunkRoute(trunk: TrunkName) {
  return asyncHandler(async (req, res) => {
    if (!samePathSecret(req.params.secret)) throw new HttpError(401, "Unknown caller.");
    const answer = await answerTrunk(trunk, (req.body ?? {}) as Record<string, unknown>);
    if (typeof answer === "string") {
      res.type("application/xml").send(answer);
      return;
    }
    res.json(answer);
  });
}

phoneRouter.post("/exotel/:secret", trunkRoute("exotel"));
phoneRouter.post("/twilio/:secret", trunkRoute("twilio"));
phoneRouter.post("/telnyx/:secret", trunkRoute("telnyx"));

/** Pipecat posts one audio chunk here. Gemini Live hears it; Friday decides; Gemini speaks the line. */
phoneRouter.post(
  "/live",
  asyncHandler(async (req, res) => {
    assertGateway(req);
    await loadPhoneConfig();
    const body = z.object({
      from: z.string().min(3),
      sessionId: z.string().min(1).max(80).optional(),
      audioBase64: z.string().min(8),
    }).parse(req.body ?? {});
    const sessionId = body.sessionId ?? body.from;
    if (getPhoneConfig().voice === "sarvam") {
      const heard = await transcribeAudio(Buffer.from(body.audioBase64, "base64"), "call.wav");
      const result = await handlePhoneTurn(body.from, heard.text, sessionId);
      const spoken = result.speak ? await synthesizeSpeech(result.speak) : { audio: Buffer.alloc(0), mime: "audio/wav" };
      res.json({ ...publicTurn(result), audioBase64: spoken.audio.toString("base64"), mime: spoken.mime });
      return;
    }
    const session = await liveSession(sessionId);
    const text = await session.hear(body.audioBase64);
    if (!text) {
      res.json({ sessionId, action: "speak", speak: "I didn't catch that.", hold: true, audioBase64: "" });
      return;
    }
    const result = await handlePhoneTurn(body.from, text, sessionId);
    const audioBase64 = result.speak ? await session.speak(result.speak) : "";
    if (result.action === "hangup" || result.action === "release") session.close();
    res.json({ ...publicTurn(result), audioBase64, mime: "audio/pcm;rate=24000" });
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
    res.json(await getUserPhoneSettings(req.user!.id));
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
    res.json(await setUserPhoneSettings(req.user!.id, { ...body, channels: body.channels as DeliveryChannel[] }));
  }),
);
