import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { entitlementsFor } from "../quota/entitlements.js";
import { createConversation, insertUserMessage } from "../chat/conversations.js";
import { ensurePreview } from "../projectBuild/sandbox.js";

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
  const conversation = await createConversation(userId, "auto", undefined, undefined, undefined, undefined, "chat", "air");
  await insertUserMessage(conversation.id, body, "text", [], userId);
  return { conversationId: conversation.id };
}

export async function openCall(userId: string, conversationId?: string) {
  if (!(await entitlementsFor(userId)).airDots) throw new HttpError(403, "Air Dots isn't on your plan.");
  const { data, error } = await supabaseAdmin
    .from("air_calls")
    .insert({ user_id: userId, conversation_id: conversationId ?? null, status: "open" })
    .select("id, status, conversation_id")
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't open the call.");
  return data;
}

export async function endCall(userId: string, callId: string) {
  const { error } = await supabaseAdmin.from("air_calls").update({ status: "ended" }).eq("id", callId).eq("user_id", userId);
  if (error) throw new HttpError(500, error.message);
}

export async function airScreen(userId: string, conversationId: string) {
  if (!(await entitlementsFor(userId)).airDots) throw new HttpError(403, "Air Dots isn't on your plan.");
  return ensurePreview(userId, conversationId);
}
