import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { entitlementsFor } from "../quota/entitlements.js";
import { createConversation, insertUserMessage } from "../chat/conversations.js";
import { ensurePreview, touchSandbox, writeSandboxFile } from "../projectBuild/sandbox.js";
import { savePassphrase } from "./passphrase.js";
import { usedCallSeconds, addCallSeconds, getPhoneConfig } from "../phone/store.js";
import { deliverResult } from "../phone/delivery.js";
import { runAirJob } from "./jobs.js";
import { dialAccount } from "../phone/trunk.js";

export type AirChannel = "whatsapp" | "telegram";

export async function linkChannel(userId: string, channel: AirChannel, externalId: string) {
  const id = externalId.trim();
  if (!id || id.length > 80) throw new HttpError(400, "That channel id is not usable.");
  if (!(await entitlementsFor(userId)).airDots) throw new HttpError(403, "Air Dots isn't on your plan.");
  const { error } = await supabaseAdmin.from("air_channels").upsert(
    { user_id: userId, channel, external_id: id },
    { onConflict: "channel,external_id" },
  );
  if (error) throw new HttpError(500, error.message);
  return { channel, externalId: id };
}

/** Unknown numbers never reach Friday. A linked number lands as a normal Air Dots chat. */
export async function acceptChannelMessage(channel: AirChannel, externalId: string, text: string) {
  const body = text.trim();
  if (!body) throw new HttpError(400, "Empty message.");
  const { data, error } = await supabaseAdmin
    .from("air_channels")
    .select("user_id")
    .eq("channel", channel)
    .eq("external_id", externalId.trim())
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Unknown caller.");
  const userId = (data as { user_id: string }).user_id;
  if (!(await entitlementsFor(userId)).airDots) throw new HttpError(403, "Air Dots isn't on your plan.");
  const passcode = body.match(/^my passcode is\s+(.+)$/i);
  if (passcode?.[1]) {
    await savePassphrase(userId, passcode[1].trim());
    return { conversationId: null, savedPassphrase: true };
  }
  const { data: existing } = await supabaseAdmin
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .eq("origin", "air")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const conversationId = (existing as { id?: string } | null)?.id
    ?? (await createConversation(userId, "auto", undefined, undefined, undefined, undefined, "chat", "air")).id;
  await insertUserMessage(conversationId, body, "text", [], userId);
  void runAirJob(userId, conversationId, body);
  return { conversationId };
}

export async function callAllowance(userId: string) {
  const entitlements = await entitlementsFor(userId);
  const limit = entitlements.airCallMinutes;
  const used = Math.round(usedCallSeconds(userId) / 60);
  return { limit, used, left: Math.max(0, limit - used) };
}

export async function openCall(userId: string, conversationId?: string) {
  const entitlements = await entitlementsFor(userId);
  if (!entitlements.airDots) throw new HttpError(403, "Air Dots isn't on your plan.");
  const allowance = await callAllowance(userId);
  if (allowance.left <= 0) throw new HttpError(402, "This month's call minutes are used up.");
  const { data, error } = await supabaseAdmin
    .from("air_calls")
    .insert({ user_id: userId, conversation_id: conversationId ?? null, status: "open" })
    .select("id, status, conversation_id")
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't open the call.");
  const dial = await placeOutboundCall(userId);
  return { ...data, dial, allowance };
}

async function placeOutboundCall(userId: string) {
  const profile = await supabaseAdmin.from("profiles").select("phone").eq("id", userId).maybeSingle();
  const to = ((profile.data as { phone?: string | null } | null)?.phone ?? "").replace(/\s/g, "");
  if (!to) return { mode: "browser" as const, reason: "no-phone" };
  return dialAccount(to);
}

export async function tickCall(userId: string, callId: string, seconds: number) {
  const allowance = await callAllowance(userId);
  if (allowance.left <= 0) throw new HttpError(402, "This month's call minutes are used up.");
  addCallSeconds(userId, Math.min(60, Math.max(1, seconds)));
  await supabaseAdmin.from("air_calls").update({ status: "open" }).eq("id", callId).eq("user_id", userId);
  return callAllowance(userId);
}

export async function endCall(userId: string, callId: string) {
  const { error } = await supabaseAdmin.from("air_calls").update({ status: "ended" }).eq("id", callId).eq("user_id", userId);
  if (error) throw new HttpError(500, error.message);
}

export async function airScreen(userId: string, conversationId: string) {
  if (!(await entitlementsFor(userId)).airDots) throw new HttpError(403, "Air Dots isn't on your plan.");
  await touchSandbox(conversationId);
  return ensurePreview(userId, conversationId);
}

export async function dropOnScreen(userId: string, conversationId: string, name: string, content: string) {
  if (!(await entitlementsFor(userId)).airDots) throw new HttpError(403, "Air Dots isn't on your plan.");
  const safe = name.replace(/[^\w.-]+/g, "-").slice(0, 80) || "drop.txt";
  await writeSandboxFile(userId, conversationId, safe, content);
  return { name: safe };
}

/** A login never goes into WhatsApp or the call as a password. The channel only opens the screen. */
export async function askForLogin(userId: string, conversationId: string, reason: string, urgent: boolean) {
  if (!(await entitlementsFor(userId)).airDots) throw new HttpError(403, "Air Dots isn't on your plan.");
  const text = `Friday needs you on the screen. ${reason} Open Air Dots and finish the login there. Do not send the password in chat.`;
  await deliverResult(userId, null, text, ["app", "telegram", "whatsapp"], getPhoneConfig());
  let call: string | null = null;
  if (urgent) {
    const opened = await openCall(userId, conversationId).catch(() => null);
    call = opened ? String((opened as { id?: string }).id ?? "") : null;
  }
  return { conversationId, urgent, call };
}
