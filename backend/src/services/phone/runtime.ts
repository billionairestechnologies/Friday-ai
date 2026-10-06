import { createConversation } from "../chat/conversations.js";
import { runTurn } from "../jobs/runTurn.js";
import { resolveEffectivePlan } from "../quota/tokenQuotaService.js";
import { entitlementsFor } from "../quota/entitlements.js";
import { assertPassphrase, parseSpokenPassphrase, setSpokenPassphrase } from "../air/passphrase.js";
import { openApproval } from "../air/gate.js";
import { latestJob, startAirJob } from "../air/jobs.js";
import { callbackIfWanted } from "./callback.js";
import { deliverResult } from "./delivery.js";
import { compressCallContext } from "./context.js";
import {
  appendTranscript,
  callByExternalId,
  endCallRecord,
  openCallRecord,
  recentCallContext,
  setCallConversation,
  transcriptLines,
  userForNumber,
  type CallRow,
} from "./calls.js";
import { PHONE_BEHAVIOR, decideTurn, overrunSpeech, type DeliveryChannel, type TurnDecision } from "./policy.js";
import { getUserPhoneSettings, loadPhoneConfig, machineOnline, registerPresence, usedCallSeconds } from "./store.js";

/**
 * One spoken turn. Words in, words out: the trunk (Exotel/Twilio/Telnyx <Say>/<Gather>) or Pipecat
 * with Gemini Live carries the audio. Friday decides the words here, through the same runtime as chat,
 * so the call shares the person's memory, meter, sandbox and connectors.
 *
 * Call state is the air_calls row (phone/calls.ts), keyed by the trunk's call id — not a Map on one
 * server — so any instance can take the next turn of a call.
 */

export type PhoneTurnResult = TurnDecision & { sessionId: string; conversationId: string | null; jobId: string | null };

function result(decision: TurnDecision, sessionId: string, call: CallRow | null, extra: Partial<PhoneTurnResult> = {}): PhoneTurnResult {
  return { ...decision, sessionId, conversationId: call?.conversation_id ?? null, jobId: null, ...extra };
}

const SENSITIVE = /\b(pay|send|delete|transfer|purchase|buy|book|order)\b/i;

async function ensureConversation(call: CallRow, build: boolean): Promise<string> {
  if (call.conversation_id) return call.conversation_id;
  const title = `Call · ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}`;
  const created = await createConversation(call.user_id, "auto", undefined, undefined, title, undefined, build ? "build" : "chat", "air");
  const id = created.id as string;
  await setCallConversation(call.id, id);
  call.conversation_id = id;
  return id;
}

/** Find this call's record, or start one for a known caller. Unknown numbers get no record. */
async function callFor(from: string, sessionId: string, trunk: string | undefined): Promise<CallRow | null> {
  const existing = await callByExternalId(sessionId);
  if (existing) return existing;
  const user = await userForNumber(from);
  if (!user) return null;
  return openCallRecord({ userId: user.id, externalId: sessionId, trunk: trunk ?? "gateway", direction: "inbound", from });
}

export async function handlePhoneTurn(from: string, text: string, sessionId?: string, _context?: string, trunk?: string): Promise<PhoneTurnResult> {
  const id = sessionId || `call_${from.replace(/\D/g, "").slice(-10) || "unknown"}`;
  const config = await loadPhoneConfig();
  const call = await callFor(from, id, trunk);
  const settings = await getUserPhoneSettings(call?.user_id ?? "");

  let plan = "free";
  let usedSeconds = 0;
  let allowed = false;
  let limitMinutes = 0;
  if (call) {
    const [effective, ents, used] = await Promise.all([
      resolveEffectivePlan(call.user_id).catch(() => null),
      entitlementsFor(call.user_id),
      usedCallSeconds(call.user_id),
    ]);
    plan = effective?.plan ?? "free";
    allowed = ents.airDots;
    limitMinutes = ents.airCallMinutes;
    // The call in progress counts too: trunks bill at hang-up, but the cap must hold mid-call.
    const live = call.direction === "browser" ? 0 : Math.max(0, (Date.now() - new Date(call.created_at).getTime()) / 1000);
    usedSeconds = used + live;
    registerPresence(call.user_id, "call", id);
    await appendTranscript(call.id, "them", text);
  }

  const decision = decideTurn({
    knownUser: Boolean(call),
    plan,
    usedSeconds,
    text,
    config,
    settings,
    machineOnline: call ? machineOnline(call.user_id) : false,
    allowed,
    limitMinutes,
  });

  const say = async (speak: string, base: TurnDecision = decision, extra: Partial<PhoneTurnResult> = {}) => {
    if (call && speak) await appendTranscript(call.id, "friday", speak);
    return result({ ...base, speak }, id, call, extra);
  };

  if (!call || decision.action === "hangup") return say(decision.speak);

  // "my passcode is …" / "change my passcode from … to …"
  const spoken = parseSpokenPassphrase(text);
  if (spoken) {
    const reply = await setSpokenPassphrase(call.user_id, spoken).catch((err: unknown) => (err instanceof Error ? err.message : "I couldn't save that passphrase."));
    return say(reply, { ...decision, action: "speak", hold: false });
  }

  // "yes … <passphrase>" before paying / sending / deleting: opens the gate on this call's
  // conversation for two minutes, and wakes a job that was waiting for this yes.
  if (/\byes\b/i.test(text) && (SENSITIVE.test(text) || (await waitingForYes(call)))) {
    const phrase = text.split(/\byes\b/i)[1]?.replace(/^[\s,.:-]+/, "").trim();
    try {
      await assertPassphrase(call.user_id, phrase || undefined);
    } catch (err) {
      return say(err instanceof Error ? err.message : "Say your passphrase.", { ...decision, action: "speak", hold: false });
    }
    const conversationId = await ensureConversation(call, decision.build);
    await openApproval(call.user_id, conversationId, "phone");
    const job = await latestJob(call.user_id, conversationId);
    if (job?.status === "needs_approval") {
      await startAirJob(call.user_id, conversationId, `Approved on the phone. Go ahead with: ${job.needs ?? job.summary ?? job.task}`, { source: "approval" });
      return say("Okay, doing it now. I'll tell you when it's done.", { ...decision, action: "release", hold: false }, { conversationId, jobId: job.id });
    }
  } else if (decision.action === "speak") {
    return say(decision.speak);
  }

  const conversationId = await ensureConversation(call, decision.build);
  // The person's words plus a short memory of this call and the last few calls (words, not audio).
  const lines = transcriptLines(call);
  const earlier = lines.length <= 1 ? await recentCallContext(call.user_id) : null;
  const content = [earlier, lines.length > 1 ? compressCallContext(lines) : null, text].filter(Boolean).join("\n\n");

  if (decision.action === "release") {
    // Long work leaves the line and continues as an Air Dot until it is done.
    const started = await startAirJob(call.user_id, conversationId, content, { source: "phone" }).catch(() => null);
    return say(decision.speak, decision, { conversationId, jobId: started?.job?.id ?? null });
  }

  const request = {
    content,
    inputMode: "voice" as const,
    think: false,
    behavior: PHONE_BEHAVIOR,
    webSearch: decision.research,
    canvas: false,
    options: { research: decision.research },
    hadAttachments: false,
  };
  const pending = runTurn({ userId: call.user_id, conversationId, kind: decision.build ? "build" : "chat", request, attachments: [] });
  const finished = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), config.maxHeldSeconds * 1000))]);

  if (!finished) {
    // Short work that overran: say so, hang up, deliver when it lands.
    void pending.then(async (late) => {
      if (!late.text.trim()) return;
      await deliverResult(call.user_id, null, late.text, decision.delivery as DeliveryChannel[], config);
      if (decision.callback) await callbackIfWanted(call.user_id, late.text);
    });
    return say(overrunSpeech(decision.delivery), { ...decision, action: "release", hold: false }, { conversationId, jobId: conversationId });
  }

  const spokenReply = finished.text.trim() || "I didn't get a result. It's in the app.";
  return say(spokenReply, { ...decision, action: "hold", hold: true }, { conversationId });
}

async function waitingForYes(call: CallRow): Promise<boolean> {
  if (!call.conversation_id) return false;
  const job = await latestJob(call.user_id, call.conversation_id).catch(() => null);
  return job?.status === "needs_approval";
}

/** The trunk or gateway says the call ended. */
export async function endPhoneCall(sessionId: string, seconds: number) {
  return endCallRecord(sessionId, seconds);
}
