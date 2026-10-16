import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { isShuttingDown } from "../lifecycle.js";
import { notifyUser } from "../pushService.js";
import { checkAndReserve, estimateReservationTokens, settleReservation } from "../quota/tokenQuotaService.js";
import { QUOTA_REASON_TEXT } from "../quota/allowance.js";
import { createConversation } from "../chat/conversations.js";
import { streamMessage } from "../chat/index.js";
import { finishGeneration, registerGeneration } from "../chat/activeGenerations.js";
import { logger } from "../../utils/logger.js";
import { isValidTimeZone, nextRunAt, zonedParts, type Frequency } from "./schedule.js";
import { entitlementsFor } from "../quota/entitlements.js";

/** Default automation limit — plans override it via the automations entitlement. */
export const MAX_AUTOMATIONS_PER_USER = 20;
const LEASE_MS = 25 * 60_000;
const RUN_TIMEOUT_MS = 20 * 60_000;
const TICK_MS = 60_000;
const BATCH = 5;

export const automationInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(8000),
  frequency: z.enum(["hourly", "daily", "weekdays", "weekly"]),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  timezone: z.string().min(1).max(64).refine(isValidTimeZone, "Unknown time zone").default("UTC"),
  research: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type AutomationInput = z.infer<typeof automationInputSchema>;

type Row = {
  id: string;
  user_id: string;
  title: string;
  prompt: string;
  frequency: Frequency;
  time_of_day: string;
  weekday: number | null;
  timezone: string;
  research: boolean;
  enabled: boolean;
  conversation_id: string | null;
  next_run_at: string;
  last_run_at: string | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  running_until: string | null;
  created_at: string;
};

export type Automation = {
  id: string;
  title: string;
  prompt: string;
  frequency: Frequency;
  timeOfDay: string;
  weekday: number | null;
  timezone: string;
  research: boolean;
  enabled: boolean;
  conversationId: string | null;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  running: boolean;
};

function toPublic(row: Row): Automation {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    frequency: row.frequency,
    timeOfDay: row.time_of_day,
    weekday: row.weekday,
    timezone: row.timezone,
    research: row.research,
    enabled: row.enabled,
    conversationId: row.conversation_id,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    running: Boolean(row.running_until && new Date(row.running_until).getTime() > Date.now()),
  };
}

function scheduleOf(input: Pick<AutomationInput, "frequency" | "timeOfDay" | "weekday" | "timezone">) {
  return { frequency: input.frequency, timeOfDay: input.timeOfDay, weekday: input.weekday ?? null, timezone: input.timezone };
}

export async function listAutomations(userId: string): Promise<Automation[]> {
  const { data, error } = await supabaseAdmin.from("automations").select("*").eq("user_id", userId).order("created_at");
  if (error) throw new HttpError(500, error.message);
  return ((data ?? []) as Row[]).map(toPublic);
}

async function getOwned(userId: string, id: string): Promise<Row> {
  const { data, error } = await supabaseAdmin.from("automations").select("*").eq("user_id", userId).eq("id", id).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Automation not found");
  return data as Row;
}

export async function createAutomation(userId: string, input: AutomationInput): Promise<Automation> {
  const { count } = await supabaseAdmin.from("automations").select("id", { count: "exact", head: true }).eq("user_id", userId);
  const allowed = (await entitlementsFor(userId)).automations;
  if ((count ?? 0) >= allowed) throw new HttpError(400, `Your plan includes up to ${allowed} automations — upgrade for more`);
  const weekday = input.frequency === "weekly" ? (input.weekday ?? 1) : null;
  const { data, error } = await supabaseAdmin
    .from("automations")
    .insert({
      user_id: userId,
      title: input.title,
      prompt: input.prompt,
      frequency: input.frequency,
      time_of_day: input.timeOfDay,
      weekday,
      timezone: input.timezone,
      research: input.research,
      enabled: input.enabled,
      next_run_at: nextRunAt(scheduleOf({ ...input, weekday })).toISOString(),
    })
    .select("*")
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to create automation");
  return toPublic(data as Row);
}

export async function updateAutomation(userId: string, id: string, patch: Partial<AutomationInput>): Promise<Automation> {
  const row = await getOwned(userId, id);
  const merged: AutomationInput = {
    title: patch.title ?? row.title,
    prompt: patch.prompt ?? row.prompt,
    frequency: patch.frequency ?? row.frequency,
    timeOfDay: patch.timeOfDay ?? row.time_of_day,
    weekday: patch.weekday !== undefined ? patch.weekday : row.weekday,
    timezone: patch.timezone ?? row.timezone,
    research: patch.research ?? row.research,
    enabled: patch.enabled ?? row.enabled,
  };
  const weekday = merged.frequency === "weekly" ? (merged.weekday ?? 1) : null;
  const { data, error } = await supabaseAdmin
    .from("automations")
    .update({
      title: merged.title,
      prompt: merged.prompt,
      frequency: merged.frequency,
      time_of_day: merged.timeOfDay,
      weekday,
      timezone: merged.timezone,
      research: merged.research,
      enabled: merged.enabled,
      next_run_at: nextRunAt(scheduleOf({ ...merged, weekday })).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to update automation");
  return toPublic(data as Row);
}

export async function deleteAutomation(userId: string, id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("automations").delete().eq("user_id", userId).eq("id", id);
  if (error) throw new HttpError(500, error.message);
}

/** Atomically takes the lease on one automation; returns the row only if this caller won it. */
async function claim(id: string, requireDue: boolean): Promise<Row | null> {
  const now = new Date().toISOString();
  let query = supabaseAdmin
    .from("automations")
    .update({ running_until: new Date(Date.now() + LEASE_MS).toISOString() })
    .eq("id", id)
    .or(`running_until.is.null,running_until.lt.${now}`);
  if (requireDue) query = query.eq("enabled", true).lte("next_run_at", now);
  const { data } = await query.select("*").maybeSingle();
  return (data as Row | null) ?? null;
}

/** "Run now" from the UI: claims the lease and runs in the background (the request returns at once). */
export async function runAutomationNow(userId: string, id: string): Promise<void> {
  await getOwned(userId, id);
  const row = await claim(id, false);
  if (!row) throw new HttpError(409, "This automation is already running");
  void executeAutomation(row, { keepSchedule: true });
}

async function ensureConversation(row: Row): Promise<string> {
  if (row.conversation_id) {
    const { data } = await supabaseAdmin.from("conversations").select("id").eq("id", row.conversation_id).maybeSingle();
    if (data) return row.conversation_id;
  }
  const created = (await createConversation(row.user_id, "auto", undefined, undefined, `⏰ ${row.title}`)) as { id: string };
  await supabaseAdmin.from("automations").update({ conversation_id: created.id }).eq("id", row.id);
  return created.id;
}

/** Runs one automation turn through the normal chat pipeline, records the outcome, reschedules. */
export async function executeAutomation(row: Row, opts: { keepSchedule?: boolean } = {}): Promise<void> {
  let status: "ok" | "error" = "ok";
  let errorText: string | null = null;
  let reply = "";
  let conversationId: string | undefined;
  try {
    const quota = await checkAndReserve(row.user_id, estimateReservationTokens(row.prompt.length + (row.research ? 20_000 : 4_000)), { feature: "automation" });
    if (!quota.allowed) throw new Error(`${QUOTA_REASON_TEXT[quota.reason]} — this run was skipped. It will try again at the next scheduled time.`);
    try {
      conversationId = await ensureConversation(row);
    } catch (err) {
      await settleReservation(quota.reservation); // streamMessage never started → release the hold
      throw err;
    }
    const local = zonedParts(new Date(), row.timezone);
    const stamp = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")} (${row.timezone})`;
    const content = `${row.prompt}\n\n_(Scheduled automation “${row.title}” · ${stamp})_`;
    // Register like any live turn: lets Stop cancel it, and keeps this path consistent with
    // chatController's normal-turn bookkeeping rather than running invisibly to that mechanism.
    const abortController = registerGeneration(conversationId, row.user_id);
    try {
      await streamMessage(
        row.user_id,
        conversationId,
        content,
        "text",
        (ev) => {
          if (ev.t === "text") reply += ev.c;
          if (ev.t === "err") {
            status = "error";
            errorText = ev.c;
          }
        },
        AbortSignal.any([abortController.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]),
        false,
        "",
        false,
        false,
        [],
        quota.reservation,
        { research: row.research },
      );
    } finally {
      finishGeneration(conversationId, abortController);
    }
  } catch (err) {
    status = "error";
    errorText = err instanceof Error ? err.message : "Automation failed";
  }

  const now = new Date();
  const next = opts.keepSchedule
    ? undefined
    : nextRunAt({ frequency: row.frequency, timeOfDay: row.time_of_day, weekday: row.weekday, timezone: row.timezone }, now).toISOString();
  await supabaseAdmin
    .from("automations")
    .update({
      last_run_at: now.toISOString(),
      last_status: status,
      last_error: errorText ? String(errorText).slice(0, 500) : null,
      running_until: null,
      ...(next ? { next_run_at: next } : {}),
    })
    .eq("id", row.id);

  const body = status === "ok" ? reply.trim().replace(/\s+/g, " ") : (errorText ?? "The run failed");
  void notifyUser(row.user_id, {
    title: status === "ok" ? `⏰ ${row.title}` : `⏰ ${row.title} failed`,
    body: body.length > 140 ? `${body.slice(0, 137)}...` : body,
    conversationId: conversationId ?? row.conversation_id ?? undefined,
  }).catch(() => {});
  logger.info("automation_run", { automationId: row.id, status });
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking || isShuttingDown()) return;
  ticking = true;
  try {
    const { data, error } = await supabaseAdmin
      .from("automations")
      .select("id")
      .eq("enabled", true)
      .lte("next_run_at", new Date().toISOString())
      .or(`running_until.is.null,running_until.lt.${new Date().toISOString()}`)
      .order("next_run_at")
      .limit(BATCH);
    if (error) {
      logger.warn("automation_tick_failed", { error: error.message });
      return;
    }
    const claimed = (await Promise.all((data ?? []).map((r) => claim(r.id as string, true)))).filter((r): r is Row => r !== null);
    await Promise.all(claimed.map((row) => executeAutomation(row)));
  } catch (err) {
    logger.warn("automation_tick_failed", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    ticking = false;
  }
}

/** Starts the in-process scheduler (safe to run on every instance — rows are claimed atomically). */
export function startAutomationScheduler(): void {
  if (timer || process.env.FRIDAY_DISABLE_AUTOMATIONS) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  setTimeout(() => void tick(), 5_000).unref();
}

export function stopAutomationScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
