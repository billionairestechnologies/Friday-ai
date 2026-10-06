import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { entitlementsFor } from "../quota/entitlements.js";
import { createConversation, insertUserMessage } from "../chat/conversations.js";
import { assertPassphrase, parseSpokenPassphrase, setSpokenPassphrase } from "./passphrase.js";
import { addCallSeconds, loadPhoneConfig, usedCallSeconds } from "../phone/store.js";
import { deliverResult } from "../phone/delivery.js";
import { openCallRecord, endCallRecord } from "../phone/calls.js";
import { placeCall } from "../phone/callback.js";
import { latestJob, startAirJob, stopAirJob } from "./jobs.js";
import { openApproval } from "./gate.js";
import { userFromTelegramCode } from "./channels.js";
import { userForNumber } from "../phone/calls.js";

/**
 * The ways into Air Dots besides the web page: WhatsApp, Telegram, the phone, and the asks Friday
 * sends out when a job needs the person (a login on the screen, a yes before paying or sending).
 * Every door lands in the same account, memory, meter and sandbox.
 */

export type AirChannel = "whatsapp" | "telegram";

async function requireAir(userId: string) {
  if (!(await entitlementsFor(userId)).airDots) throw new HttpError(403, "Air Dots isn't on your plan.");
}

export async function linkChannel(userId: string, channel: AirChannel, externalId: string) {
  const id = externalId.trim();
  if (!id || id.length > 80) throw new HttpError(400, "That channel id is not usable.");
  await requireAir(userId);
  const { error } = await supabaseAdmin.from("air_channels").upsert({ user_id: userId, channel, external_id: id }, { onConflict: "channel,external_id" });
  if (error) throw new HttpError(500, error.message);
  return { channel, externalId: id };
}

export async function listChannels(userId: string) {
  const { data } = await supabaseAdmin.from("air_channels").select("channel, external_id, created_at").eq("user_id", userId);
  return data ?? [];
}

export async function unlinkChannel(userId: string, channel: AirChannel) {
  await supabaseAdmin.from("air_channels").delete().eq("user_id", userId).eq("channel", channel);
}

const STOP = /^\s*(rukho|ruko|stop|pause|bas|cancel)\s*[.!]?\s*$/i;

async function latestAirConversation(userId: string): Promise<string> {
  const { data: existing } = await supabaseAdmin
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .eq("origin", "air")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (existing as { id?: string } | null)?.id ?? (await createConversation(userId, "auto", undefined, undefined, "Air Dots", undefined, "chat", "air")).id;
}

/**
 * A WhatsApp/Telegram message from a linked chat. Unknown chats never reach Friday. "rukho" stops,
 * "yes <passphrase>" approves a waiting step, "my passcode is …" sets the passphrase, anything else
 * starts (or continues) an Air Dot in their latest Air Dots thread.
 */
export async function acceptChannelMessage(channel: AirChannel, externalId: string, text: string) {
  const body = text.trim();
  if (!body) throw new HttpError(400, "Empty message.");
  // Telegram: "/start <code>" from the link in Air Dots settings links this chat to the account.
  const start = channel === "telegram" ? /^\/start\s+(\S+)/.exec(body) : null;
  if (start) {
    const linkUser = userFromTelegramCode(start[1]!);
    if (!linkUser) throw new HttpError(404, "Unknown caller.");
    await linkChannel(linkUser, "telegram", externalId);
    await deliverResult(linkUser, null, "Linked. You can talk to Friday here now. Say rukho to stop a job.", ["telegram"], await loadPhoneConfig());
    return { conversationId: null, linked: true };
  }
  const { data, error } = await supabaseAdmin.from("air_channels").select("user_id").eq("channel", channel).eq("external_id", externalId.trim()).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  // WhatsApp: the sender's number is the login when it matches the verified number on one account.
  const byNumber = !data && channel === "whatsapp" ? await userForNumber(externalId) : null;
  if (!data && !byNumber) throw new HttpError(404, "Unknown caller.");
  const userId = (data as { user_id: string } | null)?.user_id ?? byNumber!.id;
  await requireAir(userId);
  const config = await loadPhoneConfig();
  const tell = (message: string) => deliverResult(userId, null, message, [channel], config);

  const spoken = parseSpokenPassphrase(body);
  if (spoken) {
    await tell(await setSpokenPassphrase(userId, spoken).catch((err: unknown) => (err instanceof Error ? err.message : "Couldn't save that.")));
    return { conversationId: null, savedPassphrase: true };
  }

  const conversationId = await latestAirConversation(userId);
  if (STOP.test(body)) {
    const stopped = await stopAirJob(userId, conversationId);
    await tell(stopped.stopped ? "Stopped. The work so far is kept." : "Nothing is running.");
    return { conversationId, stopped: stopped.stopped };
  }

  const job = await latestJob(userId, conversationId);
  if (job?.status === "needs_approval" && /^\s*yes\b/i.test(body)) {
    const phrase = body.replace(/^\s*yes\b[\s,.:-]*/i, "").trim();
    try {
      await assertPassphrase(userId, phrase || undefined);
    } catch (err) {
      await tell(err instanceof Error ? err.message : "Send: yes <your passphrase>");
      return { conversationId, approved: false };
    }
    await openApproval(userId, conversationId, channel);
    await startAirJob(userId, conversationId, `Approved on ${channel}. Go ahead with: ${job.needs ?? job.summary ?? job.task}`, { source: "approval" });
    await tell("Okay, doing it now.");
    return { conversationId, approved: true };
  }

  await insertUserMessage(conversationId, body, "text", [], userId);
  const started = await startAirJob(userId, conversationId, body, { source: channel });
  if (!started.started) await tell("I'm still on the last job. Say rukho to stop it, or wait for the update.");
  return { conversationId, jobId: started.job?.id ?? null };
}

// ── Calls ───────────────────────────────────────────────────────────────────

export async function callAllowance(userId: string) {
  const entitlements = await entitlementsFor(userId);
  const limit = entitlements.airDots ? entitlements.airCallMinutes : 0;
  const usedSeconds = await usedCallSeconds(userId);
  const used = Math.ceil(usedSeconds / 60);
  return { limit, used, left: Math.max(0, limit - used), usedSeconds, visible: limit > 0 };
}

/**
 * Call now. With a trunk configured, Friday rings the verified mobile on the account; without one (or
 * without a phone number), the browser line on On Air is the call. Either way there is one air_calls row.
 */
export async function openCall(userId: string, conversationId?: string) {
  await requireAir(userId);
  const allowance = await callAllowance(userId);
  if (!allowance.visible) throw new HttpError(403, "Calls are on the Pro and Premium plans.");
  if (allowance.left <= 0) throw new HttpError(402, "This month's call minutes are used up.");
  const dial = await placeCall(userId, { direction: "outbound", greeting: "Friday here. What do you need?", conversationId });
  if (dial.placed) return { id: dial.callId, status: "dialing", conversation_id: conversationId ?? null, dial: { mode: "phone" as const, trunk: dial.trunk }, allowance };
  const call = await openCallRecord({ userId, direction: "browser", conversationId: conversationId ?? null, status: "open" });
  return { id: call.id, status: call.status, conversation_id: call.conversation_id, dial: { mode: "browser" as const, reason: dial.reason }, allowance };
}

/** The browser line bills as it runs: one tick per ≤60 s, stopped at the cap. */
export async function tickCall(userId: string, callId: string, seconds: number) {
  const { data } = await supabaseAdmin.from("air_calls").select("id, status").eq("id", callId).eq("user_id", userId).maybeSingle();
  if (!data || (data as { status: string }).status === "ended") throw new HttpError(404, "That call has ended.");
  const before = await callAllowance(userId);
  if (before.left <= 0) {
    await endCall(userId, callId);
    throw new HttpError(402, "This month's call minutes are used up.");
  }
  await addCallSeconds(userId, Math.min(60, Math.max(1, seconds)));
  await supabaseAdmin.from("air_calls").update({ seconds: before.usedSeconds }).eq("id", callId);
  return callAllowance(userId);
}

export async function endCall(userId: string, callId: string) {
  const { data } = await supabaseAdmin.from("air_calls").select("id, seconds").eq("id", callId).eq("user_id", userId).maybeSingle();
  if (!data) throw new HttpError(404, "No such call.");
  await endCallRecord(callId, (data as { seconds: number }).seconds ?? 0, true);
}

export async function listCalls(userId: string, limit = 20) {
  const { data } = await supabaseAdmin
    .from("air_calls")
    .select("id, direction, status, seconds, summary, conversation_id, created_at, ended_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

// ── When a job needs the person ──────────────────────────────────────────────

async function askEverywhere(userId: string, conversationId: string, text: string, urgent: boolean) {
  const config = await loadPhoneConfig();
  await deliverResult(userId, null, text, ["app", "telegram", "whatsapp"], config);
  // Urgent and nobody has answered after 10 minutes: ring them (inside the minutes and quiet rules).
  if (urgent) {
    setTimeout(() => {
      void (async () => {
        const job = await latestJob(userId, conversationId);
        if (job && (job.status === "needs_login" || job.status === "needs_approval")) {
          await placeCall(userId, { direction: "callback", greeting: `Friday here. ${text}`, conversationId, urgent: true });
        }
      })().catch(() => undefined);
    }, 10 * 60_000).unref?.();
  }
}

/** A login never goes into WhatsApp or the call as a password. The channel only opens the screen. */
export async function askForLogin(userId: string, conversationId: string, reason: string, urgent: boolean) {
  await requireAir(userId);
  const text = `Friday needs you to sign in. ${reason} Open Air Dots and finish it on the screen. Never send a password in chat.`;
  await askEverywhere(userId, conversationId, text, urgent);
  return { conversationId, urgent };
}

/** Pay, send, book, delete: one yes from any door (web button, "yes <passphrase>" on WhatsApp/phone). */
export async function askForApproval(userId: string, conversationId: string, what: string, urgent: boolean) {
  await requireAir(userId);
  const text = `Friday is waiting for your yes: ${what} Approve it in Air Dots, or reply "yes" and your passphrase.`;
  await askEverywhere(userId, conversationId, text, urgent);
  return { conversationId, urgent };
}

/** The web "Approve" button. The person is signed in; the passphrase is still asked once it is set. */
export async function approveFromWeb(userId: string, conversationId: string, passphrase?: string) {
  await requireAir(userId);
  await assertPassphrase(userId, passphrase);
  await openApproval(userId, conversationId, "web");
  const job = await latestJob(userId, conversationId);
  if (job?.status === "needs_approval") {
    return startAirJob(userId, conversationId, `Approved. Go ahead with: ${job.needs ?? job.summary ?? job.task}`, { source: "approval" });
  }
  return { started: false as const, reason: "nothing-waiting" as const, job };
}

/** After the person finished a login on the screen: carry on. */
export async function continueAfterLogin(userId: string, conversationId: string) {
  await requireAir(userId);
  const job = await latestJob(userId, conversationId);
  return startAirJob(userId, conversationId, `The person has signed in on the screen. Continue: ${job?.needs ?? job?.task ?? "the job"}`, { source: "web" });
}
