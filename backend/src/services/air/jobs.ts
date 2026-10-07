import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { logger } from "../../utils/logger.js";
import { entitlementsFor } from "../quota/entitlements.js";
import { runTurn } from "../jobs/runTurn.js";
import { INSTANCE_ID, requestStop } from "../jobs/turns.js";
import { stopGeneration } from "../chat/activeGenerations.js";
import { AIR_BEHAVIOR } from "./prompt.js";
import { deliverResult } from "../phone/delivery.js";
import { loadPhoneConfig } from "../phone/store.js";
import type { DeliveryChannel } from "../phone/policy.js";
import { callbackIfWanted } from "../phone/callback.js";
import { dotInstructionsFor } from "./dots.js";

/**
 * An Air Dot: a job that keeps working in the person's conversation until it is done, they say
 * "rukho"/stop, it needs them (a login, a yes), or the Friday usage meter runs out.
 *
 * Before: the HTTP request waited for the whole loop (up to 12 model turns, so proxies timed it out),
 * "done" was guessed by a regex over the reply ("I'm not done yet" stopped it), and the running/halted
 * sets lived in one server's memory. Now:
 *   - a job is an air_jobs row (migration 0056); the route returns at once and the loop runs here;
 *   - the model reports its state through the air_report tool (air/tools.ts) — no word matching;
 *   - stop is a column, checked every few seconds by whichever instance holds the lease;
 *   - a job whose lease runs out (crash, deploy) is resumed by the sweeper on another instance.
 */

export type AirJobStatus = "running" | "done" | "blocked" | "needs_login" | "needs_approval" | "stopped" | "failed" | "out_of_meter";
export type AirJobSource = "web" | "phone" | "whatsapp" | "telegram" | "approval";

export type AirJob = {
  id: string;
  user_id: string;
  conversation_id: string;
  task: string;
  source: AirJobSource;
  status: AirJobStatus;
  summary: string | null;
  needs: string | null;
  rounds: number;
  stop_requested: boolean;
  urgent: boolean;
  lease_owner: string | null;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

export const LEASE_MS = 60_000;
const HEARTBEAT_MS = 5_000;
export const MAX_AIR_ROUNDS = 12;
export const CONTINUE_PROMPT =
  "Keep going on the same job from where you stopped. When it is finished, blocked, or needs the person, call air_report and stop.";

/** What a finished round means for the job. Pure; tested. */
export function nextStep(input: {
  reported: AirJobStatus | "working" | null;
  turnFailed: boolean;
  turnAborted: boolean;
  stopRequested: boolean;
  quotaStopped: boolean;
  round: number;
  maxRounds: number;
  replyText: string;
}): { continue: boolean; status: AirJobStatus } {
  if (input.stopRequested || input.turnAborted) return { continue: false, status: "stopped" };
  if (input.quotaStopped) return { continue: false, status: "out_of_meter" };
  if (input.turnFailed) return { continue: false, status: "failed" };
  if (input.reported && input.reported !== "working" && input.reported !== "running") return { continue: false, status: input.reported };
  // The model must say it's still working to get another round. A plain answer with no report is a
  // finished one-turn job ("what's the weather") — it never loops by default.
  if (input.reported !== "working") return { continue: false, status: input.replyText.trim() ? "done" : "failed" };
  if (input.round >= input.maxRounds) return { continue: false, status: "blocked" };
  return { continue: true, status: "running" };
}

async function loadJob(id: string): Promise<AirJob | null> {
  const { data } = await supabaseAdmin.from("air_jobs").select("*").eq("id", id).maybeSingle();
  return (data as AirJob | null) ?? null;
}

export async function latestJob(userId: string, conversationId: string): Promise<AirJob | null> {
  const { data } = await supabaseAdmin
    .from("air_jobs")
    .select("*")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as AirJob | null) ?? null;
}

export async function runningJobFor(conversationId: string): Promise<AirJob | null> {
  const { data } = await supabaseAdmin.from("air_jobs").select("*").eq("conversation_id", conversationId).eq("status", "running").maybeSingle();
  return (data as AirJob | null) ?? null;
}

/** Called by the air_report tool inside a turn. */
export async function reportFromModel(conversationId: string, report: { status: "working" | "done" | "blocked" | "needs_login" | "needs_approval"; summary: string; needs?: string | null }) {
  const job = await runningJobFor(conversationId);
  if (!job) return null;
  await supabaseAdmin
    .from("air_jobs")
    .update({ summary: report.summary.slice(0, 2000), needs: report.needs?.slice(0, 500) ?? null, updated_at: new Date().toISOString() })
    .eq("id", job.id);
  reported.set(job.id, report.status);
  return job.id;
}

// The report of the round in progress, keyed by job id. Local on purpose: the tool runs inside the
// turn, and the turn runs on the instance that owns the job's lease.
const reported = new Map<string, AirJobStatus | "working">();

/**
 * Start an Air Dot. Returns at once; the work continues in the background. One running job per
 * conversation (a unique index enforces it): asking again while it runs returns the running one.
 */
export async function startAirJob(userId: string, conversationId: string, task: string, opts: { source?: AirJobSource; urgent?: boolean } = {}) {
  if (!(await entitlementsFor(userId)).airDots) throw new HttpError(403, "Air Dots isn't on your plan.");
  const running = await runningJobFor(conversationId);
  if (running && running.lease_until && new Date(running.lease_until).getTime() > Date.now()) {
    return { started: false as const, reason: "already-running" as const, job: running };
  }
  if (running) {
    // A dead lease: close it so the new job can take the slot.
    await supabaseAdmin.from("air_jobs").update({ status: "failed", summary: "Interrupted.", finished_at: new Date().toISOString() }).eq("id", running.id).eq("status", "running");
  }
  const { data, error } = await supabaseAdmin
    .from("air_jobs")
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      task: task.slice(0, 8000),
      source: opts.source ?? "web",
      urgent: Boolean(opts.urgent),
      status: "running",
      lease_owner: INSTANCE_ID,
      lease_until: new Date(Date.now() + LEASE_MS).toISOString(),
    })
    .select("*")
    .single();
  if (error || !data) {
    if (error?.code === "23505") {
      const job = await runningJobFor(conversationId);
      return { started: false as const, reason: "already-running" as const, job };
    }
    throw new HttpError(500, error?.message ?? "Couldn't start the Air Dot.");
  }
  const job = data as AirJob;
  void runJobLoop(job, false).catch((err) => logger.warn("air_job_crashed", { jobId: job.id, error: err instanceof Error ? err.message : String(err) }));
  return { started: true as const, job };
}

/** "rukho" / stop: flag the job; the instance running it sees the flag within a few seconds. */
export async function stopAirJob(userId: string, conversationId: string) {
  const { data } = await supabaseAdmin
    .from("air_jobs")
    .update({ stop_requested: true, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .eq("status", "running")
    .select("id");
  await requestStop(conversationId, userId).catch(() => undefined);
  return { stopped: Boolean(data?.length) };
}

/** Kept for the chat Stop button (chatController). */
export function haltAirJob(conversationId: string) {
  void supabaseAdmin.from("air_jobs").update({ stop_requested: true }).eq("conversation_id", conversationId).eq("status", "running").then(() => undefined, () => undefined);
}

function isQuotaStop(text: string) {
  return /usage limit|limit reached|out of (credits|usage)|meter is empty|plan limit/i.test(text.slice(-400));
}

async function finish(job: AirJob, status: AirJobStatus, lastText: string) {
  const now = new Date().toISOString();
  const fresh = await loadJob(job.id);
  const summary = fresh?.summary || lastText.trim().slice(0, 2000) || null;
  await supabaseAdmin
    .from("air_jobs")
    .update({ status, summary, finished_at: now, updated_at: now, lease_owner: null, lease_until: null })
    .eq("id", job.id);
  reported.delete(job.id);
  await announce({ ...job, ...(fresh ?? {}), status, summary }).catch((err) => logger.warn("air_job_announce_failed", { jobId: job.id, error: err instanceof Error ? err.message : String(err) }));
}

/** Tell the person: the thread already has the reply; the channels and (if wanted) a call get the news. */
async function announce(job: AirJob) {
  const config = await loadPhoneConfig();
  const channels: DeliveryChannel[] = ["app"];
  if (config.channels.telegram) channels.push("telegram");
  if (config.channels.whatsapp) channels.push("whatsapp");
  const summary = (job.summary ?? "").trim();
  const { askForLogin, askForApproval } = await import("./doors.js");
  if (job.status === "needs_login") {
    await askForLogin(job.user_id, job.conversation_id, job.needs || summary || "A site needs you to sign in.", job.urgent);
    return;
  }
  if (job.status === "needs_approval") {
    await askForApproval(job.user_id, job.conversation_id, job.needs || summary || "Friday needs a yes before the next step.", job.urgent);
    return;
  }
  if (job.status === "stopped") return; // they asked for it; no ping
  const text =
    job.status === "done" ? summary || "Done."
    : job.status === "out_of_meter" ? `Friday stopped: your usage for now is used up. ${summary}`.trim()
    : job.status === "blocked" ? `Friday is stuck: ${summary || "it couldn't finish."}`
    : `Friday couldn't finish this. ${summary}`.trim();
  await deliverResult(job.user_id, null, text, channels, config);
  if (job.status === "done") await callbackIfWanted(job.user_id, summary || "Your job is done.");
}

/**
 * The loop. Holds the lease while it runs (heartbeat every 5 s), which is also when it checks the stop
 * flag and aborts the running turn if it was set from another instance.
 */
export async function runJobLoop(job: AirJob, resumed: boolean): Promise<void> {
  let stopSeen = false;
  const heartbeat = setInterval(() => {
    void (async () => {
      const { data } = await supabaseAdmin
        .from("air_jobs")
        .update({ lease_until: new Date(Date.now() + LEASE_MS).toISOString() })
        .eq("id", job.id)
        .eq("lease_owner", INSTANCE_ID)
        .eq("status", "running")
        .select("stop_requested");
      const row = data?.[0] as { stop_requested?: boolean } | undefined;
      if (!row) return;
      if (row.stop_requested && !stopSeen) {
        stopSeen = true;
        stopGeneration(job.conversation_id, job.user_id);
      }
    })().catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let lastText = "";
  try {
    const maxRounds = Math.min(MAX_AIR_ROUNDS, (await entitlementsFor(job.user_id)).buildMaxRounds || MAX_AIR_ROUNDS);
    // A named dot's standing instructions travel as behaviour, not as words in the thread.
    const dot = await dotInstructionsFor(job.conversation_id).catch(() => null);
    const behavior = dot?.instructions ? `${AIR_BEHAVIOR}\n\nYou are working as "${dot.name}". Standing instructions from the person: ${dot.instructions}` : AIR_BEHAVIOR;
    for (let round = job.rounds + 1; ; round++) {
      const before = await loadJob(job.id);
      if (!before || before.status !== "running") return;
      if (before.stop_requested) return finish(job, "stopped", lastText);
      reported.delete(job.id);
      const first = round === 1 && !resumed;
      const result = await runTurn({
        userId: job.user_id,
        conversationId: job.conversation_id,
        kind: "chat",
        request: {
          content: first ? job.task : CONTINUE_PROMPT,
          inputMode: "text",
          think: false,
          behavior,
          webSearch: false,
          canvas: false,
          options: {},
          hadAttachments: false,
        },
        attachments: [],
      });
      lastText = result.text;
      await supabaseAdmin.from("air_jobs").update({ rounds: round, updated_at: new Date().toISOString() }).eq("id", job.id);
      const after = await loadJob(job.id);
      const step = nextStep({
        reported: reported.get(job.id) ?? null,
        turnFailed: result.failed,
        turnAborted: result.aborted,
        stopRequested: Boolean(after?.stop_requested) || stopSeen,
        quotaStopped: result.failed && isQuotaStop(result.text),
        round,
        maxRounds,
        replyText: result.text,
      });
      if (!step.continue) return finish(job, step.status, lastText);
    }
  } catch (err) {
    logger.warn("air_job_failed", { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    await finish(job, "failed", lastText);
  } finally {
    clearInterval(heartbeat);
  }
}

/** Jobs whose owner stopped renewing the lease (crash, deploy): take them over and continue. */
export async function resumeStaleAirJobs(): Promise<number> {
  const { data } = await supabaseAdmin
    .from("air_jobs")
    .select("*")
    .eq("status", "running")
    .lt("lease_until", new Date().toISOString())
    .limit(20);
  let taken = 0;
  for (const row of (data ?? []) as AirJob[]) {
    const { data: claimed } = await supabaseAdmin
      .from("air_jobs")
      .update({ lease_owner: INSTANCE_ID, lease_until: new Date(Date.now() + LEASE_MS).toISOString() })
      .eq("id", row.id)
      .eq("status", "running")
      .eq("lease_until", row.lease_until as string)
      .select("*");
    const job = claimed?.[0] as AirJob | undefined;
    if (!job) continue;
    taken++;
    void runJobLoop(job, true).catch(() => undefined);
  }
  return taken;
}

let sweep: NodeJS.Timeout | null = null;
export function startAirJobSweeper(intervalMs = 30_000) {
  if (sweep || process.env.FRIDAY_DISABLE_AIR_RESUME) return;
  sweep = setInterval(() => void resumeStaleAirJobs().catch(() => undefined), intervalMs);
  sweep.unref?.();
}

/** Test hook. */
export function setReportedForTests(jobId: string, status: AirJobStatus | "working" | null) {
  if (status) reported.set(jobId, status);
  else reported.delete(jobId);
}
