import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../utils/logger.js";

/**
 * Durable record of the turns being generated right now (table active_turns, migration 0042).
 *
 * A turn already outlives the HTTP connection (closing the app only drops the SSE socket — see
 * chat/activeGenerations.ts), but "running" used to be a Map in ONE process: other instances and a
 * freshly deployed process didn't know about it, Stop only worked on the right instance, and a deploy
 * mid-build killed the build without a word. Each turn now heartbeats a row; turnSweeper.ts resumes or
 * reports any turn whose heartbeat stopped.
 */

/** This process. Rows it owns are the ones it heartbeats. */
export const INSTANCE_ID = `${process.env.RAILWAY_REPLICA_ID ?? process.env.HOSTNAME ?? "local"}-${randomUUID().slice(0, 8)}`;

export const HEARTBEAT_MS = 15_000;
/** No heartbeat for this long = the process running it is gone. */
export const STALE_MS = 75_000;

export type TurnKind = "chat" | "research" | "build";
export type TurnRequest = {
  content: string;
  inputMode: "text" | "voice";
  think: boolean;
  behavior: string;
  webSearch: boolean;
  canvas: boolean;
  options: Record<string, unknown>;
  hadAttachments: boolean;
};

type Running = { conversationId: string; controller: AbortController; timer: ReturnType<typeof setInterval> };
const mine = new Map<string, Running>();

export function localTurnCount(): number {
  return mine.size;
}

/** Records the turn as running and heartbeats it until endTurn; a Stop from any instance aborts it. */
export async function beginTurn(conversationId: string, userId: string, kind: TurnKind, request: TurnRequest, controller: AbortController, resumeCount = 0): Promise<void> {
  const { error } = await supabaseAdmin.from("active_turns").upsert({
    conversation_id: conversationId,
    user_id: userId,
    kind,
    request,
    instance_id: INSTANCE_ID,
    status: "running",
    stop_requested: false,
    resume_count: resumeCount,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
  });
  // Never block a turn on bookkeeping (e.g. migration 0042 not applied yet): it just isn't resumable.
  if (error) logger.warn("active_turn_begin_failed", { conversationId, error: error.message });
  const timer = setInterval(() => void heartbeat(conversationId, controller), HEARTBEAT_MS);
  timer.unref?.();
  const previous = mine.get(conversationId);
  if (previous) clearInterval(previous.timer);
  mine.set(conversationId, { conversationId, controller, timer });
}

async function heartbeat(conversationId: string, controller: AbortController) {
  const { data } = await supabaseAdmin
    .from("active_turns")
    .update({ heartbeat_at: new Date().toISOString() })
    .eq("conversation_id", conversationId)
    .eq("instance_id", INSTANCE_ID)
    .select("stop_requested")
    .maybeSingle();
  if (data?.stop_requested && !controller.signal.aborted) controller.abort();
}

export async function endTurn(conversationId: string): Promise<void> {
  const entry = mine.get(conversationId);
  if (entry) clearInterval(entry.timer);
  mine.delete(conversationId);
  await supabaseAdmin.from("active_turns").delete().eq("conversation_id", conversationId).eq("instance_id", INSTANCE_ID);
}

/** True while some instance is generating this conversation (fresh heartbeat). */
export async function isTurnRunning(conversationId: string): Promise<boolean> {
  if (mine.has(conversationId)) return true;
  const { data } = await supabaseAdmin.from("active_turns").select("heartbeat_at").eq("conversation_id", conversationId).maybeSingle();
  return Boolean(data && Date.now() - new Date(data.heartbeat_at as string).getTime() < STALE_MS);
}

/** Running conversations among `ids` (one query, for sidebars/lists). */
export async function runningAmong(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const { data } = await supabaseAdmin.from("active_turns").select("conversation_id").in("conversation_id", ids).gte("heartbeat_at", cutoff);
  return new Set((data ?? []).map((r) => r.conversation_id as string));
}

/** Stop pressed — works whichever instance is running the turn (its heartbeat sees the flag). */
export async function requestStop(conversationId: string, userId: string): Promise<void> {
  const local = mine.get(conversationId);
  if (local) local.controller.abort();
  await supabaseAdmin.from("active_turns").update({ stop_requested: true }).eq("conversation_id", conversationId).eq("user_id", userId);
}

/**
 * Graceful shutdown: give running turns up to `ms` to finish, then hand the rest over — their
 * heartbeat is backdated so another instance (or this one after the restart) picks them up at once.
 */
export async function drainTurns(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (mine.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  if (!mine.size) return;
  const ids = [...mine.keys()];
  for (const entry of mine.values()) clearInterval(entry.timer);
  await supabaseAdmin.from("active_turns").update({ heartbeat_at: new Date(0).toISOString() }).in("conversation_id", ids).eq("instance_id", INSTANCE_ID);
  logger.info("turns_handed_over", { count: ids.length });
}

/** Atomically claims stale turns for this instance (two sweepers can't both take one). */
export type ClaimedTurn = { conversation_id: string; user_id: string; kind: TurnKind; request: TurnRequest; resume_count: number };

export async function claimStaleTurns(): Promise<ClaimedTurn[]> {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const { data: stale } = await supabaseAdmin.from("active_turns").select("conversation_id").eq("status", "running").lt("heartbeat_at", cutoff).limit(20);
  const claimed: ClaimedTurn[] = [];
  for (const row of stale ?? []) {
    if (mine.has(row.conversation_id as string)) continue; // ours and alive — a slow DB write, not a dead process
    const { data } = await supabaseAdmin
      .from("active_turns")
      .update({ status: "resuming", instance_id: INSTANCE_ID, heartbeat_at: new Date().toISOString() })
      .eq("conversation_id", row.conversation_id)
      .eq("status", "running")
      .lt("heartbeat_at", cutoff)
      .select("conversation_id, user_id, kind, request, resume_count")
      .maybeSingle();
    if (data) claimed.push(data as ClaimedTurn);
  }
  return claimed;
}

/** The turn turned out to be a Build (decided inside the chat pipeline) — resumable as one. */
export async function setTurnKind(conversationId: string, kind: TurnKind): Promise<void> {
  await supabaseAdmin.from("active_turns").update({ kind }).eq("conversation_id", conversationId).eq("instance_id", INSTANCE_ID);
}
