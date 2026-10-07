import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../utils/logger.js";
import { addCallSeconds } from "./store.js";

/**
 * The call record (air_calls, migrations 0052 + 0056). Every call — browser line, inbound, outbound,
 * callback — is one row with the trunk's own call id, the transcript (words only; raw audio is never
 * kept or replayed, that would re-bill every minute) and the seconds billed. It replaces the per-server
 * Maps the trunk code used for history, sessions and queued callbacks.
 */

export type CallRow = {
  id: string;
  user_id: string;
  conversation_id: string | null;
  external_id: string | null;
  trunk: string | null;
  direction: "browser" | "inbound" | "outbound" | "callback";
  from_number: string | null;
  greeting: string | null;
  status: "dialing" | "open" | "ended";
  transcript: { role: "them" | "friday"; text: string; at: string }[];
  seconds: number;
  summary: string | null;
  created_at: string;
  ended_at: string | null;
};

export function last10(value: string) {
  return value.replace(/\D/g, "").slice(-10);
}

/** Caller ID is the login. Indexed lookup on profiles.phone_last10 (one row, not a table scan). */
export async function userForNumber(from: string): Promise<{ id: string } | null> {
  const needle = last10(from);
  if (needle.length < 8) return null;
  const { data, error } = await supabaseAdmin.from("profiles").select("id").eq("phone_last10", needle).limit(2);
  if (error || !data?.length) return null;
  // Two accounts on one number: refuse rather than guess whose Friday this is.
  if (data.length > 1) {
    logger.warn("phone_number_ambiguous", { last4: needle.slice(-4) });
    return null;
  }
  return { id: (data[0] as { id: string }).id };
}

export async function callByExternalId(externalId: string): Promise<CallRow | null> {
  if (!externalId) return null;
  const { data } = await supabaseAdmin.from("air_calls").select("*").eq("external_id", externalId).maybeSingle();
  return (data as CallRow | null) ?? null;
}

export async function openCallRecord(row: {
  userId: string;
  externalId?: string | null;
  trunk?: string | null;
  direction: CallRow["direction"];
  from?: string | null;
  conversationId?: string | null;
  greeting?: string | null;
  status?: CallRow["status"];
}): Promise<CallRow> {
  const { data, error } = await supabaseAdmin
    .from("air_calls")
    .insert({
      user_id: row.userId,
      external_id: row.externalId ?? null,
      trunk: row.trunk ?? null,
      direction: row.direction,
      from_number: row.from ? last10(row.from) : null,
      conversation_id: row.conversationId ?? null,
      greeting: row.greeting ?? null,
      status: row.status ?? "open",
    })
    .select("*")
    .single();
  if (error || !data) {
    // Two webhooks for the same call raced: the other one created it.
    if (error?.code === "23505" && row.externalId) {
      const existing = await callByExternalId(row.externalId);
      if (existing) return existing;
    }
    throw new Error(error?.message ?? "Couldn't record the call.");
  }
  return data as CallRow;
}

export async function setCallConversation(callId: string, conversationId: string) {
  await supabaseAdmin.from("air_calls").update({ conversation_id: conversationId }).eq("id", callId);
}

const MAX_LINES = 400;

export async function appendTranscript(callId: string, role: "them" | "friday", text: string) {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return;
  const { data } = await supabaseAdmin.from("air_calls").select("transcript").eq("id", callId).maybeSingle();
  const transcript = ((data as { transcript?: CallRow["transcript"] } | null)?.transcript ?? []).slice(-(MAX_LINES - 1));
  transcript.push({ role, text: line.slice(0, 2000), at: new Date().toISOString() });
  await supabaseAdmin.from("air_calls").update({ transcript }).eq("id", callId);
}

export function transcriptLines(call: Pick<CallRow, "transcript">): string[] {
  return (call.transcript ?? []).map((l) => `${l.role === "them" ? "Them" : "Friday"}: ${l.text}`);
}

/** A one-line summary for the call list and the next call's context (no model call needed). */
export function summarizeTranscript(call: Pick<CallRow, "transcript">): string | null {
  const lines = call.transcript ?? [];
  if (!lines.length) return null;
  const firstAsk = lines.find((l) => l.role === "them")?.text ?? "";
  const lastAnswer = [...lines].reverse().find((l) => l.role === "friday")?.text ?? "";
  return `Asked: ${firstAsk.slice(0, 160)}${lastAnswer ? ` — Friday: ${lastAnswer.slice(0, 200)}` : ""}`;
}

/**
 * The trunk said the call ended: mark it, bill the seconds (atomic), keep a summary. Idempotent — a
 * second "completed" webhook for the same call bills nothing.
 */
export async function endCallRecord(externalIdOrId: string, seconds: number, byId = false): Promise<{ ok: boolean; usedSeconds?: number }> {
  const call = byId
    ? ((await supabaseAdmin.from("air_calls").select("*").eq("id", externalIdOrId).maybeSingle()).data as CallRow | null)
    : await callByExternalId(externalIdOrId);
  if (!call) return { ok: false };
  const { data: closed } = await supabaseAdmin
    .from("air_calls")
    .update({ status: "ended", ended_at: new Date().toISOString(), seconds: Math.max(0, Math.round(seconds)), summary: summarizeTranscript(call) })
    .eq("id", call.id)
    .neq("status", "ended")
    .select("id");
  if (!closed?.length) return { ok: true };
  // Browser-line calls are billed as they run (tick), so only trunk calls bill here.
  const usedSeconds = call.direction === "browser" ? undefined : await addCallSeconds(call.user_id, seconds);
  return { ok: true, usedSeconds };
}

/** An outbound call Friday placed and is waiting to be answered (Call now, a callback, an urgent ask). */
export async function pendingDialFor(from: string): Promise<CallRow | null> {
  const user = await userForNumber(from);
  if (!user) return null;
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data } = await supabaseAdmin
    .from("air_calls")
    .select("*")
    .eq("user_id", user.id)
    .eq("status", "dialing")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as CallRow | null) ?? null;
}

/** The trunk answered the call Friday placed: bind the trunk's id to the row and open it. */
export async function answerDial(callId: string, externalId: string, trunk: string) {
  await supabaseAdmin.from("air_calls").update({ status: "open", external_id: externalId || null, trunk }).eq("id", callId).eq("status", "dialing");
}

/** The last few calls, so a new call starts knowing what was said before (words only). */
export async function recentCallContext(userId: string, limit = 3): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("air_calls")
    .select("summary, created_at")
    .eq("user_id", userId)
    .eq("status", "ended")
    .not("summary", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  const rows = (data ?? []) as { summary: string; created_at: string }[];
  if (!rows.length) return null;
  return [
    "Earlier calls with this person (for reference only — don't read these out; use one detail only if it helps):",
    ...rows.map((r) => `- ${r.created_at.slice(0, 10)}: ${r.summary}`),
  ].join("\n");
}
