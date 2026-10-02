import type { ChatImage } from "../providers/types.js";
import type { Reservation } from "../quota/tokenQuotaService.js";
import type { StreamEvent } from "../chat/types.js";
import { streamMessage } from "../chat/index.js";
import { registerGeneration, finishGeneration } from "../chat/activeGenerations.js";
import { createEventRecorder } from "../projectBuild/events.js";
import { notifyUser } from "../pushService.js";
import { beginTurn, endTurn, type TurnKind, type TurnRequest } from "./turns.js";

/**
 * One chat / research / Build turn, run to completion whether or not anyone is watching: it is
 * registered as running (durable, cross-instance), every event is logged so any device can replay
 * and follow it live (GET /chat/conversations/:id/live), and when nobody was connected at the end
 * the user gets a push notification. Used by the HTTP route and by the sweeper that resumes turns a
 * restart interrupted.
 */
export async function runTurn(opts: {
  userId: string;
  conversationId: string;
  kind: TurnKind;
  request: TurnRequest;
  attachments: ChatImage[];
  reservation?: Reservation;
  /** Live listener (the SSE response). Absent for a headless resumed turn. */
  onEvent?: (ev: StreamEvent) => void;
  /** Whether the live listener is still connected — decides whether to notify at the end. */
  listening?: () => boolean;
  resumeCount?: number;
}): Promise<{ text: string; failed: boolean; aborted: boolean }> {
  const { userId, conversationId, request } = opts;
  const controller = registerGeneration(conversationId, userId);
  const recorder = createEventRecorder(conversationId);
  await recorder.reset().catch(() => undefined);
  await beginTurn(conversationId, userId, opts.kind, request, controller, opts.resumeCount ?? 0);
  let text = "";
  let failed = false;
  const emit = (ev: StreamEvent) => {
    if (ev.t === "text") text += ev.c;
    if (ev.t === "err") failed = true;
    recorder.record(ev);
    opts.onEvent?.(ev);
  };
  try {
    await streamMessage(
      userId,
      conversationId,
      request.content,
      request.inputMode,
      emit,
      controller.signal,
      request.think,
      request.behavior,
      request.webSearch,
      request.canvas,
      opts.attachments,
      opts.reservation,
      request.options as Parameters<typeof streamMessage>[12],
    );
  } catch (err) {
    emit({ t: "err", c: err instanceof Error ? err.message : "Something went wrong" });
    emit({ t: "done" });
  } finally {
    await recorder.close().catch(() => undefined);
    finishGeneration(conversationId, controller);
    await endTurn(conversationId).catch(() => undefined);
  }
  const aborted = controller.signal.aborted;
  // Nobody watching when it finished (app closed, phone locked) → tell them it's ready.
  // Builds notify themselves (projectBuild/notify.ts) with build-specific wording.
  if (opts.kind !== "build" && !(opts.listening?.() ?? false) && !failed && !aborted && text.trim()) {
    const body = text.trim().replace(/\s+/g, " ");
    void notifyUser(userId, {
      title: opts.kind === "research" ? "Your research report is ready" : "Friday replied",
      body: body.length > 140 ? `${body.slice(0, 137)}...` : body,
      conversationId,
    }).catch(() => undefined);
  }
  return { text, failed, aborted };
}
