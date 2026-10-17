import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../utils/logger.js";

/**
 * Durable background jobs (supabase 0066). enqueue() writes a row; the worker claims due jobs under
 * a lease (one running job per tenant, so a big customer can't starve others), runs the registered
 * handler, heartbeats while it runs, and completes / retries with backoff / dead-letters. A crashed
 * worker's lease expires and job_recover() requeues it — so every handler MUST be idempotent (do the
 * work keyed on the job's own ids: credit grants keyed per person, emails deduped per notification).
 *
 * Throw a NonRetryableJobError for bad input (dead at once); any other error retries.
 */

export class NonRetryableJobError extends Error {}

export type JobHandler = (payload: Record<string, unknown>, job: { id: string; attempts: number }) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();
export function registerJobHandler(kind: string, handler: JobHandler) {
  handlers.set(kind, handler);
}

export async function enqueueJob(kind: string, payload: Record<string, unknown>, opts: { tenant?: string | null; idempotencyKey?: string; maxAttempts?: number; runAfter?: Date } = {}): Promise<{ id: string; duplicate: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("jobs")
    .insert({ kind, payload, tenant: opts.tenant ?? null, idempotency_key: opts.idempotencyKey ?? null, max_attempts: opts.maxAttempts ?? 5, run_after: (opts.runAfter ?? new Date()).toISOString() })
    .select("id")
    .single();
  if (!error && data) return { id: data.id as string, duplicate: false };
  if (error && /duplicate|23505/.test(`${error.code} ${error.message}`) && opts.idempotencyKey) {
    const { data: existing } = await supabaseAdmin.from("jobs").select("id").eq("idempotency_key", opts.idempotencyKey).maybeSingle();
    if (existing) return { id: existing.id as string, duplicate: true };
  }
  throw new Error(`enqueue failed: ${error?.message ?? "unknown"}`);
}

const WORKER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const LEASE_SECONDS = 120;
const POLL_MS = 2_000;
const CONCURRENCY = Math.max(1, Number(process.env.FRIDAY_JOB_CONCURRENCY ?? 4));

let running = 0;
let stopping = false;
let timer: NodeJS.Timeout | null = null;
let lastRecover = 0;
const inflight = new Set<Promise<void>>();

async function runOne(job: { id: string; kind: string; payload: Record<string, unknown>; attempts: number }) {
  const handler = handlers.get(job.kind);
  const beat = setInterval(() => void supabaseAdmin.rpc("job_heartbeat", { p_job: job.id, p_worker: WORKER, p_lease_seconds: LEASE_SECONDS }), (LEASE_SECONDS / 3) * 1000);
  beat.unref?.();
  try {
    if (!handler) throw new NonRetryableJobError(`no handler for job kind "${job.kind}"`);
    const result = await handler(job.payload ?? {}, { id: job.id, attempts: job.attempts });
    await supabaseAdmin.rpc("job_complete", { p_job: job.id, p_worker: WORKER, p_result: (result ?? {}) as object });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { data } = await supabaseAdmin.rpc("job_fail", { p_job: job.id, p_worker: WORKER, p_error: message, p_retryable: !(err instanceof NonRetryableJobError) });
    (data === "dead" ? logger.error : logger.warn)("job_failed", { jobId: job.id, kind: job.kind, attempt: job.attempts, outcome: data, error: message.slice(0, 300) });
  } finally {
    clearInterval(beat);
  }
}

async function tick() {
  if (stopping) return;
  try {
    if (Date.now() - lastRecover > 30_000) {
      lastRecover = Date.now();
      await supabaseAdmin.rpc("job_recover");
    }
    const free = CONCURRENCY - running;
    if (free <= 0) return;
    const { data, error } = await supabaseAdmin.rpc("job_claim", { p_worker: WORKER, p_limit: free, p_lease_seconds: LEASE_SECONDS });
    if (error) {
      if (!/does not exist|schema cache/i.test(error.message)) logger.warn("job_claim_failed", { error: error.message });
      return;
    }
    for (const job of (data ?? []) as Array<{ id: string; kind: string; payload: Record<string, unknown>; attempts: number }>) {
      running++;
      const p = runOne(job).finally(() => {
        running--;
        inflight.delete(p);
      });
      inflight.add(p);
    }
  } catch (err) {
    logger.warn("job_tick_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

export function startJobWorker() {
  if (timer || process.env.FRIDAY_DISABLE_JOBS) return;
  timer = setInterval(() => void tick(), POLL_MS);
  timer.unref?.();
}

/** Graceful shutdown: stop claiming, give running jobs `ms` to finish; anything left is recovered by its expired lease. */
export async function stopJobWorker(ms: number) {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, ms))]);
}

export async function jobsOverview() {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const [counts, problems] = await Promise.all([
    supabaseAdmin.from("jobs").select("status, kind").gte("updated_at", since).limit(5000),
    supabaseAdmin.from("jobs").select("id, kind, status, tenant, attempts, max_attempts, last_error, run_after, updated_at, created_at").in("status", ["dead", "queued", "running"]).order("updated_at", { ascending: false }).limit(100),
  ]);
  const by: Record<string, number> = {};
  for (const r of counts.data ?? []) by[r.status as string] = (by[r.status as string] ?? 0) + 1;
  const queued = (problems.data ?? []).filter((j) => j.status === "queued");
  const oldestQueuedSec = queued.length ? Math.round((Date.now() - Math.min(...queued.map((j) => Date.parse(j.created_at as string)))) / 1000) : 0;
  return { last24h: by, oldestQueuedSec, jobs: problems.data ?? [] };
}

/** Console: put a dead job back in the queue (fresh attempts) or cancel a queued one. */
export async function retryJob(id: string) {
  const { data, error } = await supabaseAdmin.from("jobs").update({ status: "queued", attempts: 0, run_after: new Date().toISOString(), worker: null, lease_until: null, updated_at: new Date().toISOString() }).eq("id", id).in("status", ["dead", "cancelled"]).select("id").maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}
export async function cancelJob(id: string) {
  const { data, error } = await supabaseAdmin.from("jobs").update({ status: "cancelled", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id).eq("status", "queued").select("id").maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}
