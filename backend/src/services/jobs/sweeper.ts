import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../utils/logger.js";
import { insertAssistantMessage } from "../chat/conversations.js";
import { isShuttingDown } from "../lifecycle.js";
import { notifyUser } from "../pushService.js";
import { checkAndReserve, estimateReservationTokens } from "../quota/tokenQuotaService.js";
import { runTurn } from "./runTurn.js";
import { claimStaleTurns, type ClaimedTurn } from "./turns.js";

/**
 * Picks up turns whose process died (deploy, crash, scale-in) — their heartbeat stopped.
 *
 * - A Build turn RESUMES automatically on this instance: the project's files, FRIDAY.md and git
 *   history are saved, so the agent is told the server restarted and continues from the project's
 *   real state (at most twice per turn, so a turn that keeps crashing the server can't loop).
 * - A chat or research turn can't safely be replayed (it would bill and search again from zero),
 *   so it's closed with a visible note and a push notification asking the user to send it again.
 */
const SWEEP_MS = 30_000;
const MAX_RESUMES = 2;

const RESUME_PROMPT =
  "Continue the task from where it stopped — Friday's server restarted in the middle of it. First check the project's " +
  "current state (list_files, FRIDAY.md, run `git log --oneline -5` and `git status`), then carry on with the remaining work and finish as usual.";

async function resume(turn: ClaimedTurn) {
  const reservation = await checkAndReserve(turn.user_id, estimateReservationTokens(RESUME_PROMPT.length)).catch(() => null);
  if (!reservation?.allowed) return interrupted(turn, "Your usage limit was reached, so it couldn't continue automatically.");
  const options = { ...(turn.request.options ?? {}) };
  delete options.repo; // already cloned on the first run
  logger.info("turn_resuming", { conversationId: turn.conversation_id, attempt: turn.resume_count + 1 });
  await runTurn({
    userId: turn.user_id,
    conversationId: turn.conversation_id,
    kind: turn.kind,
    request: { ...turn.request, content: RESUME_PROMPT, options },
    attachments: [],
    reservation: reservation.reservation,
    resumeCount: turn.resume_count + 1,
  });
}

async function interrupted(turn: ClaimedTurn, extra = "") {
  await supabaseAdmin.from("active_turns").delete().eq("conversation_id", turn.conversation_id);
  const what = turn.kind === "research" ? "This research" : turn.kind === "build" ? "This build" : "This reply";
  await insertAssistantMessage(
    turn.conversation_id,
    `${what} was interrupted by a server restart before it finished. ${extra || "Send your message again to continue."}`.trim(),
    "Friday",
    { usedCanvas: false, usedSearch: false, usedThink: false, error: "interrupted" },
  ).catch(() => undefined);
  await notifyUser(turn.user_id, { title: `${what} was interrupted`, body: "Open the chat to continue.", conversationId: turn.conversation_id }).catch(() => undefined);
}

async function sweep() {
  if (isShuttingDown()) return;
  const claimed = await claimStaleTurns().catch(() => []);
  for (const turn of claimed) {
    if (turn.kind === "build" && turn.resume_count < MAX_RESUMES && !turn.request.hadAttachments) {
      // Not awaited: a resumed build runs for minutes; the sweep keeps going.
      void resume(turn).catch((err) => logger.error("turn_resume_failed", { conversationId: turn.conversation_id, error: err instanceof Error ? err.message : String(err) }));
    } else {
      await interrupted(turn);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startTurnSweeper() {
  if (timer || process.env.FRIDAY_DISABLE_TURN_RESUME === "1") return;
  // First sweep shortly after boot: turns the previous process handed over are picked up quickly.
  setTimeout(() => void sweep(), 8_000).unref?.();
  timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref?.();
}

export function stopTurnSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}
