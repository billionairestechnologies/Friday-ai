import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { createConversation } from "../chat/conversations.js";
import { entitlementsFor } from "../quota/entitlements.js";

/**
 * Dots: the Air Dots threads a person names and gives standing instructions, shown with a mascot.
 * Each is one conversation (origin 'air') — same account, memory, usage meter and machine as the rest
 * of Friday. The instructions ride along as the job's behaviour (air/jobs.ts), never as a fake user
 * message, so the thread stays exactly what was said.
 */

export const FACES = ["blob", "cat", "droid", "ghost", "star", "cloud", "clover"] as const;
export const MOTIONS = ["working", "searching", "solving", "listening", "connecting", "weaving", "composing", "breathing", "shaping"] as const;
export const MAX_DOTS = 12;

export type AirDot = {
  id: string;
  conversation_id: string;
  name: string;
  instructions: string;
  face: string;
  color: string;
  motion: string;
  sort: number;
  created_at: string;
};

const COLUMNS = "id, conversation_id, name, instructions, face, color, motion, sort, created_at";

async function requireAir(userId: string) {
  if (!(await entitlementsFor(userId)).airDots) throw new HttpError(403, "Air Dots isn't on your plan.");
}

/** The person's dots; a first visit gets one, Friday, so the page is never empty. */
export async function listDots(userId: string): Promise<AirDot[]> {
  await requireAir(userId);
  const { data, error } = await supabaseAdmin.from("air_dots").select(COLUMNS).eq("user_id", userId).order("sort").order("created_at");
  if (error) throw new HttpError(500, error.message);
  if (data?.length) return data as AirDot[];
  return [await createDot(userId, { name: "Friday", instructions: "Stay on what I ask until it is done. Ask before paying, sending or deleting.", face: "clover", color: "#8eb7e8", motion: "working" })];
}

export type DotInput = { name?: string; instructions?: string; face?: string; color?: string; motion?: string; sort?: number };

function clean(input: DotInput) {
  const row: Record<string, unknown> = {};
  if (input.name !== undefined) row.name = input.name.trim().slice(0, 40) || "Dot";
  if (input.instructions !== undefined) row.instructions = input.instructions.trim().slice(0, 2000);
  if (input.face !== undefined) row.face = (FACES as readonly string[]).includes(input.face) ? input.face : "blob";
  if (input.color !== undefined) row.color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : "#8eb7e8";
  if (input.motion !== undefined) row.motion = (MOTIONS as readonly string[]).includes(input.motion) ? input.motion : "working";
  if (input.sort !== undefined) row.sort = Math.max(0, Math.min(1000, Math.round(input.sort)));
  return row;
}

export async function createDot(userId: string, input: DotInput): Promise<AirDot> {
  await requireAir(userId);
  const { count } = await supabaseAdmin.from("air_dots").select("id", { count: "exact", head: true }).eq("user_id", userId);
  if ((count ?? 0) >= MAX_DOTS) throw new HttpError(400, `You can have up to ${MAX_DOTS} dots.`);
  const name = (input.name ?? "").trim().slice(0, 40) || "Dot";
  const conversation = await createConversation(userId, "auto", undefined, undefined, name, undefined, "chat", "air");
  const { data, error } = await supabaseAdmin
    .from("air_dots")
    .insert({ user_id: userId, conversation_id: conversation.id, name, ...clean({ ...input, name }) })
    .select(COLUMNS)
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Couldn't make that dot.");
  return data as AirDot;
}

export async function updateDot(userId: string, id: string, input: DotInput): Promise<AirDot> {
  const { data, error } = await supabaseAdmin
    .from("air_dots")
    .update({ ...clean(input), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "No such dot.");
  if (input.name) await supabaseAdmin.from("conversations").update({ title: (data as AirDot).name }).eq("id", (data as AirDot).conversation_id);
  return data as AirDot;
}

/** Removing a dot keeps its conversation (it stays in chat history); only the dot goes. */
export async function deleteDot(userId: string, id: string) {
  const { error } = await supabaseAdmin.from("air_dots").delete().eq("id", id).eq("user_id", userId);
  if (error) throw new HttpError(500, error.message);
}

/** The standing instructions for the dot on this conversation, if any (read by the job loop). */
export async function dotInstructionsFor(conversationId: string): Promise<{ name: string; instructions: string } | null> {
  const { data } = await supabaseAdmin.from("air_dots").select("name, instructions").eq("conversation_id", conversationId).maybeSingle();
  return (data as { name: string; instructions: string } | null) ?? null;
}

export async function recentJobs(userId: string, conversationId: string, limit = 10) {
  const { data } = await supabaseAdmin
    .from("air_jobs")
    .select("id, task, status, summary, needs, rounds, source, created_at, finished_at")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}
