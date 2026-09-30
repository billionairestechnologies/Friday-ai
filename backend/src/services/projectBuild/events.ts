import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { isGenerating } from "../chat/activeGenerations.js";
import type { StreamEvent } from "../chat/types.js";

/**
 * Build event log (build_events): every stream event of the current Build turn, appended as it
 * happens, so a device that wasn't connected — a reload, the phone after starting on the laptop —
 * replays the turn from the start and then keeps following it (GET /api/build/:id/events?after=).
 * Writes are batched (a build streams many step updates a second) and never block the build.
 */
const FLUSH_MS = 400;

export function createEventRecorder(conversationId: string) {
  let buffer: StreamEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const flush = () => {
    timer = null;
    if (buffer.length === 0) return chain;
    const rows = buffer.map((payload) => ({ conversation_id: conversationId, payload }));
    buffer = [];
    chain = chain.then(async () => {
      const { error } = await supabaseAdmin.from("build_events").insert(rows);
      if (error) console.error("[build] event log write failed:", error.message);
    });
    return chain;
  };

  return {
    /** Starts a new turn's log (the previous turn's events are no longer needed). */
    async reset() {
      await supabaseAdmin.from("build_events").delete().eq("conversation_id", conversationId);
    },
    record(ev: StreamEvent) {
      buffer.push(ev);
      if (!timer) timer = setTimeout(() => void flush(), FLUSH_MS);
    },
    /** Writes whatever is buffered (call when the turn ends). */
    async close() {
      if (timer) clearTimeout(timer);
      await flush();
    },
  };
}

export type LoggedEvent = { id: number; event: StreamEvent };

/** Events after `after` (0 = from the start of the turn), plus whether the turn is still running. */
export async function readEvents(conversationId: string, after: number): Promise<{ events: LoggedEvent[]; running: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("build_events")
    .select("id, payload")
    .eq("conversation_id", conversationId)
    .gt("id", after)
    .order("id", { ascending: true })
    .limit(2000);
  if (error) throw new HttpError(500, error.message);
  return {
    events: (data ?? []).map((row) => ({ id: Number(row.id), event: row.payload as StreamEvent })),
    running: isGenerating(conversationId),
  };
}
