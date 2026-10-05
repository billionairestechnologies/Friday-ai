import { supabaseAdmin } from "../../config/supabase.js";
import { createConversation } from "../chat/conversations.js";
import { runTurn } from "../jobs/runTurn.js";
import { resolveEffectivePlan } from "../quota/tokenQuotaService.js";
import { assertPassphrase } from "../air/passphrase.js";
import { deliverResult } from "./delivery.js";
import {
  PHONE_BEHAVIOR,
  decideTurn,
  overrunSpeech,
  type DeliveryChannel,
  type TurnDecision,
} from "./policy.js";
import {
  addCallSeconds,
  getPhoneConfig,
  getUserPhoneSettings,
  hydrateUserPhone,
  loadPhoneConfig,
  machineOnline,
  registerPresence,
  usedCallSeconds,
} from "./store.js";

export type PhoneTurnResult = TurnDecision & { sessionId: string; conversationId: string | null; jobId: string | null };

type Session = { id: string; userId: string | null; conversationId: string | null; from: string };

const sessions = new Map<string, Session>();

function digits(value: string) {
  return value.replace(/\D/g, "").slice(-10);
}

async function userForNumber(from: string): Promise<{ id: string; email: string | null } | null> {
  const needle = digits(from);
  if (needle.length < 8) return null;
  const { data, error } = await supabaseAdmin.from("profiles").select("id, phone").not("phone", "is", null);
  if (error || !data) return null;
  const row = (data as { id: string; phone: string | null }[]).find((profile) => digits(profile.phone ?? "") === needle);
  if (!row) return null;
  return { id: row.id, email: null };
}

async function ensureConversation(session: Session, userId: string, build: boolean) {
  if (session.conversationId) return session.conversationId;
  const created = await createConversation(userId, "auto", undefined, undefined, "Phone call", undefined, build ? "build" : "chat");
  session.conversationId = created.id as string;
  return session.conversationId;
}

async function dispatch(userId: string, email: string | null, text: string, channels: DeliveryChannel[]) {
  await deliverResult(userId, email, text, channels, getPhoneConfig());
}

export async function handlePhoneTurn(from: string, text: string, sessionId?: string): Promise<PhoneTurnResult> {
  const id = sessionId || `call_${digits(from) || "unknown"}`;
  const session = sessions.get(id) ?? { id, userId: null, conversationId: null, from };
  sessions.set(id, session);
  await loadPhoneConfig();
  const user = session.userId ? { id: session.userId, email: null } : await userForNumber(from);
  if (user) session.userId = user.id;

  const config = getPhoneConfig();
  const settings = user ? getUserPhoneSettings(user.id) : getUserPhoneSettings("");
  let plan = "free";
  let usedSeconds = 0;
  if (user) {
    await hydrateUserPhone(user.id);
    plan = (await resolveEffectivePlan(user.id).catch(() => null))?.plan ?? "free";
    usedSeconds = usedCallSeconds(user.id);
    registerPresence(user.id, "call", id);
  }

  const decision = decideTurn({
    knownUser: Boolean(user),
    plan,
    usedSeconds,
    text,
    config,
    settings,
    machineOnline: user ? machineOnline(user.id) : false,
  });

  if (!user || decision.action === "hangup" || decision.action === "speak") {
    return { ...decision, sessionId: id, conversationId: session.conversationId, jobId: null };
  }

  if (/\byes\b/i.test(text) && /\b(pay|send|delete|transfer|purchase)\b/i.test(text)) {
    const phrase = text.split(/\byes\b/i)[1]?.trim();
    try {
      await assertPassphrase(user.id, phrase);
    } catch (err) {
      return {
        ...decision,
        action: "speak",
        speak: err instanceof Error ? err.message : "Say your passphrase.",
        hold: false,
        sessionId: id,
        conversationId: session.conversationId,
        jobId: null,
      };
    }
  }

  const conversationId = await ensureConversation(session, user.id, decision.build);
  const request = {
    content: text,
    inputMode: "voice" as const,
    think: false,
    behavior: PHONE_BEHAVIOR,
    webSearch: decision.research,
    canvas: false,
    options: { research: decision.research },
    hadAttachments: false,
  };

  if (decision.action === "release") {
    const jobId = conversationId;
    void runTurn({
      userId: user.id,
      conversationId,
      kind: decision.build ? "build" : decision.research ? "research" : "chat",
      request,
      attachments: [],
    }).then((result) => {
      if (result.text.trim()) void dispatch(user.id, user.email, result.text, decision.delivery);
    });
    return { ...decision, sessionId: id, conversationId, jobId };
  }

  const pending = runTurn({
    userId: user.id,
    conversationId,
    kind: decision.build ? "build" : "chat",
    request,
    attachments: [],
  });
  const result = await Promise.race([
    pending,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), config.maxHeldSeconds * 1000)),
  ]);

  if (!result) {
    void pending.then((finished) => {
      if (finished.text.trim()) void dispatch(user.id, user.email, finished.text, decision.delivery);
    });
    return {
      ...decision,
      action: "release",
      speak: overrunSpeech(decision.delivery),
      hold: false,
      sessionId: id,
      conversationId,
      jobId: conversationId,
    };
  }

  const spoken = result.text.trim() || "I didn't catch a result. It's in the app.";
  void dispatch(user.id, user.email, spoken, decision.delivery);
  return {
    ...decision,
    action: "hold",
    speak: spoken,
    hold: true,
    sessionId: id,
    conversationId,
    jobId: null,
  };
}

export async function endPhoneCall(sessionId: string, seconds: number) {
  const session = sessions.get(sessionId);
  if (!session?.userId) return { ok: false };
  addCallSeconds(session.userId, seconds);
  sessions.delete(sessionId);
  return { ok: true, usedSeconds: usedCallSeconds(session.userId) };
}
