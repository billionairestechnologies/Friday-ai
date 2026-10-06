import { timingSafeEqual } from "node:crypto";
import { answerDial, endCallRecord, openCallRecord, pendingDialFor, userForNumber } from "./calls.js";
import { UNKNOWN_CALLER } from "./policy.js";

export type TrunkName = "exotel" | "twilio" | "telnyx";

function last10(value: string) {
  return value.replace(/\D/g, "").slice(-10);
}

/** Calls, transcripts and pending greetings live in air_calls now (phone/calls.ts). Kept for tests. */
export function resetTrunks() {}

export function samePathSecret(given: string | undefined) {
  const expected = process.env.PHONE_GATEWAY_SECRET ?? "";
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hookUrl(trunk: TrunkName) {
  const secret = process.env.PHONE_GATEWAY_SECRET ?? "";
  const base = (process.env.PUBLIC_API_URL ?? "").replace(/\/$/, "");
  if (!secret || !base) return "";
  return `${base}/api/phone/${trunk}/${secret}`;
}

function digits(value: string) {
  return value.replace(/\D/g, "");
}

export function trunkForNumber(to: string): TrunkName {
  const d = digits(to);
  const india = d.startsWith("91") || d.length === 10;
  if (india) return "exotel";
  if (process.env.TELNYX_API_KEY && process.env.TELNYX_CONNECTION_ID) return "telnyx";
  return "twilio";
}

export function xmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderExotel(speak: string, hangup: boolean) {
  const url = hookUrl("exotel");
  const say = `<Say>${xmlEscape(speak)}</Say>`;
  const next = hangup || !url ? "<Hangup/>" : `<Gather input="speech" action="${xmlEscape(url)}" method="POST" timeout="5"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}${next}</Response>`;
}

export function renderTwilio(speak: string, hangup: boolean) {
  const url = hookUrl("twilio");
  const say = `<Say>${xmlEscape(speak)}</Say>`;
  if (hangup || !url) return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Hangup/></Response>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="${xmlEscape(url)}" method="POST" speechTimeout="auto">${say}</Gather></Response>`;
}

type Inbound = { from: string; to: string; text: string; sessionId: string; event: string };

export function readInbound(body: Record<string, unknown>): Inbound {
  const data = (body.data ?? {}) as { event_type?: string; payload?: Record<string, unknown> };
  const payload = data.payload ?? {};
  const transcription = (payload.transcription_data ?? body.transcription_data ?? {}) as { transcript?: string };
  const from = String(body.From ?? body.from ?? payload.from ?? payload.caller_id_number ?? "");
  const to = String(body.To ?? body.to ?? payload.to ?? payload.called_number ?? "");
  const text = String(body.SpeechResult ?? body.speechResult ?? body.text ?? body.transcript ?? transcription.transcript ?? "").trim();
  const sessionId = String(body.CallSid ?? body.CallSid ?? body.call_sid ?? payload.call_control_id ?? body.sessionId ?? from);
  const event = String(data.event_type ?? body.CallStatus ?? body.Status ?? "");
  return { from, to, text, sessionId, event };
}

export function dialPayload(to: string) {
  const trunk = trunkForNumber(to);
  const url = hookUrl(trunk);
  return { trunk, url, to: to.replace(/\s/g, "") };
}

/** Place the call when that trunk's keys exist. Otherwise the browser line is the call. */
export async function dialAccount(to: string): Promise<{ mode: "browser" | "phone"; trunk: TrunkName | "browser" }> {
  const plan = dialPayload(to);
  if (!plan.url || !plan.to) return { mode: "browser", trunk: "browser" };
  if (plan.trunk === "exotel") {
    const sid = process.env.EXOTEL_SID ?? "";
    const token = process.env.EXOTEL_TOKEN ?? "";
    const key = process.env.EXOTEL_API_KEY ?? "";
    const callerId = process.env.EXOTEL_CALLER_ID ?? "";
    if (!sid || !token || !key || !callerId) return { mode: "browser", trunk: "browser" };
    // EXOTEL_FLOW_URL = an Exotel app flow with the Voicebot applet pointed at the Pipecat bridge (the
    // natural Gemini Live voice). Without it, our own ExoML hook speaks with Exotel's TTS.
    const body = new URLSearchParams({ From: plan.to, CallerId: callerId, CallType: "trans", Url: process.env.EXOTEL_FLOW_URL || plan.url });
    const res = await fetch(`https://${key}:${token}@api.exotel.com/v1/Accounts/${sid}/Calls/connect`, { method: "POST", body }).catch(() => null);
    return { mode: res?.ok ? "phone" : "browser", trunk: res?.ok ? "exotel" : "browser" };
  }
  if (plan.trunk === "telnyx") {
    const key = process.env.TELNYX_API_KEY ?? "";
    const connection = process.env.TELNYX_CONNECTION_ID ?? "";
    const from = process.env.TELNYX_CALLER_ID ?? "";
    if (!key || !connection || !from) return { mode: "browser", trunk: "browser" };
    const res = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: connection, to: plan.to, from, webhook_url: plan.url }),
    }).catch(() => null);
    return { mode: res?.ok ? "phone" : "browser", trunk: res?.ok ? "telnyx" : "browser" };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  const from = process.env.TWILIO_CALLER_ID ?? "";
  if (!sid || !token || !from) return { mode: "browser", trunk: "browser" };
  const body = new URLSearchParams({ To: plan.to, From: from, Url: plan.url });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
    body,
  }).catch(() => null);
  return { mode: res?.ok ? "phone" : "browser", trunk: res?.ok ? "twilio" : "browser" };
}

/**
 * The phone was picked up (or rang in). A call Friday placed (Call now, a callback, an urgent ask) has
 * its greeting waiting; on an outbound leg the person is "To" (Twilio/Telnyx) or "From" (Exotel
 * connect). Otherwise caller ID decides: a known number opens a call, an unknown one hears one line.
 */
export async function pickUp(trunk: string, inbound: { from: string; to: string; sessionId: string }): Promise<{ speak: string; hangup: boolean; known: boolean }> {
  for (const number of [inbound.to, inbound.from]) {
    if (!number) continue;
    const dial = await pendingDialFor(number);
    if (dial) {
      await answerDial(dial.id, inbound.sessionId, trunk);
      return { speak: dial.greeting || "Friday here.", hangup: false, known: true };
    }
  }
  const user = await userForNumber(inbound.from);
  if (!user) return { speak: UNKNOWN_CALLER, hangup: true, known: false };
  await openCallRecord({ userId: user.id, externalId: inbound.sessionId, trunk, direction: "inbound", from: inbound.from });
  return { speak: "Friday here.", hangup: false, known: true };
}

/** TwiML that hands the call's audio to the Pipecat bridge (airdots/pipecat). */
export function renderTwilioStream(inbound: { from: string; to: string; sessionId: string }) {
  const ws = process.env.PIPECAT_WS_URL ?? "";
  const params = [["from", inbound.from], ["to", inbound.to], ["trunk", "twilio"]]
    .map(([k, v]) => `<Parameter name="${k}" value="${xmlEscape(v ?? "")}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEscape(ws)}">${params}</Stream></Connect></Response>`;
}

export async function answerTrunk(trunk: TrunkName, body: Record<string, unknown>) {
  const inbound = readInbound(body);
  const reply = (speak: string, hangup: boolean) =>
    trunk === "telnyx" ? telnyxCommands(inbound, speak, hangup) : trunk === "twilio" ? renderTwilio(speak, hangup) : renderExotel(speak, hangup);

  if (/hangup|completed|canceled|busy|no-answer|failed/i.test(inbound.event)) {
    const seconds = Number(body.Duration ?? body.DialCallDuration ?? body.CallDuration ?? body.duration ?? 0) || 0;
    if (inbound.sessionId) await endCallRecord(inbound.sessionId, seconds);
    return trunk === "telnyx" ? { action: "hangup", speak: "" } : reply("Goodbye.", true);
  }

  if (!inbound.text) {
    // With the Pipecat voice bridge configured, Twilio streams the audio there (Gemini Live voice)
    // instead of <Say>/<Gather>; the bridge calls /api/phone/answer and /turn itself.
    if (trunk === "twilio" && process.env.PIPECAT_WS_URL) return renderTwilioStream(inbound);
    const picked = await pickUp(trunk, inbound);
    return reply(picked.speak, picked.hangup);
  }

  const { handlePhoneTurn } = await import("./runtime.js");
  const result = await handlePhoneTurn(inbound.from, inbound.text, inbound.sessionId, undefined, trunk);
  return reply(result.speak, result.action === "hangup" || result.action === "release");
}

async function telnyxCommands(inbound: Inbound, speak: string, hangup: boolean) {
  const key = process.env.TELNYX_API_KEY ?? "";
  const id = inbound.sessionId;
  if (key && id && !/^[+\d]+$/.test(id)) {
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    if (/initiated/i.test(inbound.event)) {
      await fetch(`https://api.telnyx.com/v2/calls/${id}/actions/answer`, { method: "POST", headers, body: "{}" }).catch(() => undefined);
    }
    if (speak) {
      await fetch(`https://api.telnyx.com/v2/calls/${id}/actions/speak`, {
        method: "POST",
        headers,
        body: JSON.stringify({ payload: speak, voice: "female", language: "en-US" }),
      }).catch(() => undefined);
    }
    if (hangup) await fetch(`https://api.telnyx.com/v2/calls/${id}/actions/hangup`, { method: "POST", headers, body: "{}" }).catch(() => undefined);
  }
  return { action: hangup ? "hangup" : "speak", speak, sessionId: id };
}
