import { logger } from "../../utils/logger.js";
import { priceUsage } from "../finance/pricing.js";
import { emptyTokenUsage, mergeTokenUsage, normalizeUsage, usageDelta, type TokenUsage } from "../tokenUsage.js";
import { billableTokens, METER_VERSION, QUOTA_STOP_MESSAGE, type QuotaBlockReason } from "./allowance.js";
import {
  extendHold,
  QuotaUnavailableError,
  recordUsage,
  settleReservation,
  type LedgerFeature,
  type RecordResult,
  type Reservation,
  type UsageEvent,
} from "./tokenQuotaService.js";

export type MeteredModel = { slug: string; modelId: string };

export type CallMeta = {
  /** ok | partial (output began, then the call failed) | failed (no output) | aborted (client left). */
  status?: UsageEvent["call_status"];
  streaming?: boolean;
  latencyMs?: number;
  attempt?: number;
  requestId?: string | null;
  /**
   * false = recorded for cost and audit but not charged to the customer's allowance (billable 0):
   * the losing side of a hedged race we started for latency, and routing probes they didn't ask for.
   */
  chargeable?: boolean;
};

/** Called once per usage-notice threshold crossed (80/95/100 %). Injected so the meter stays I/O-light in tests. */
export type NoticeSink = (userId: string, threshold: number, periodEnd: string | null) => void;

let noticeSink: NoticeSink = () => undefined;
export function setUsageNoticeSink(sink: NoticeSink) {
  noticeSink = sink;
}

type Pricer = (slug: string, modelId: string, usage: TokenUsage) => Promise<{ costUsd: number | null; sellInr: number | null; priced: boolean }>;
let pricer: Pricer = priceUsage;
/** Test hook: the cost columns come from Console → Finance pricing, which needs the database. */
export function setUsagePricerForTests(next: Pricer | null) {
  pricer = next ?? priceUsage;
}

/**
 * Meters one turn (a chat reply, a Build run, a Team Up panel, an automation, a FridayX request)
 * against its reservation. Every upstream model invocation becomes exactly one ledger row:
 *
 * - recordCall(model, usage)        one invocation whose usage is known on its own.
 * - recordCumulative(model, total)  agent loops report a RUNNING total; what's new since the last
 *                                   report becomes one row (one round). Re-reporting the same total
 *                                   records nothing, so the final reconcile can never double-count.
 *
 * A row whose write failed is retried with the SAME idempotency key before anything newer is
 * written — a response lost after the database committed can't produce a second row. If the
 * ledger stays unreachable the turn is stopped (`unavailable`): we never keep calling models we
 * can't account for. A turn with no reservation is a bug; its usage is logged loudly, not dropped.
 */
export class UsageMeter {
  /** Running totals already turned into ledger rows, per stream (agent loops report running totals). */
  private baselines = new Map<string, TokenUsage>();
  /** Rows not yet confirmed by the database, oldest first; each keeps its idempotency key across retries. */
  private queue: UsageEvent[] = [];
  private seq = 0;
  private blocked: QuotaBlockReason | null = null;
  /** Flushes run one at a time (helpers record fire-and-forget, so two could otherwise overlap and skip a row). */
  private chain: Promise<unknown> = Promise.resolve();
  /** Records still being prepared/written; settle() waits for them so no row lands after the hold is released. */
  private inflight = new Set<Promise<unknown>>();

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    void work.finally(() => this.inflight.delete(work)).catch(() => undefined);
    return work;
  }
  /** Billable tokens confirmed in the ledger by this meter. */
  billable = 0;

  constructor(
    readonly reservation: Reservation | undefined,
    private readonly ctx: { userId: string; organizationId?: string | null; feature: LedgerFeature; conversationId?: string | null },
  ) {}

  /** Once routing knows what the turn is (Build, Team Up), later rows are filed under it. */
  setFeature(feature: LedgerFeature) {
    this.ctx.feature = feature;
  }

  /** Why the turn must stop (balance used up / ledger unreachable), or null to carry on. */
  get stopReason(): QuotaBlockReason | null {
    return this.blocked;
  }

  get stopMessage(): string | null {
    return this.blocked ? QUOTA_STOP_MESSAGE[this.blocked] : null;
  }

  /** Records one model invocation (a zero-usage failed attempt is recorded too, for the audit trail). Returns false when the turn must start no further calls. */
  recordCall(model: MeteredModel, usage: TokenUsage, meta: CallMeta = {}): Promise<boolean> {
    return this.track(
      (async () => {
        this.queue.push(await this.event(model, normalizeUsage(usage), meta));
        return this.flush();
      })(),
    );
  }

  /**
   * Records what `cumulative` — a running total for `stream` — added since the last report. The
   * baseline moves when the row is QUEUED, so a row still waiting for the database is never
   * counted a second time by the next report.
   */
  recordCumulative(model: MeteredModel, cumulative: TokenUsage, meta: CallMeta = {}, stream = "main"): Promise<boolean> {
    const base = this.baselines.get(stream) ?? emptyTokenUsage();
    const delta = usageDelta(cumulative, base);
    if (delta.promptTokens === 0 && delta.completionTokens === 0) return this.flush();
    this.baselines.set(stream, mergeTokenUsage(base, delta));
    return this.track(
      (async () => {
        this.queue.push(await this.event(model, delta, meta));
        return this.flush();
      })(),
    );
  }

  /**
   * Makes sure the reservation holds at least `tokens` for the next call (the real prompt, or the
   * next agent round about to re-send the transcript). Refused when the balance can't cover it —
   * which is what stops two concurrent turns from both spending the last tokens.
   */
  async ensureHold(tokens: number): Promise<boolean> {
    if (this.blocked) return false;
    if (!this.reservation) return true;
    const result = await extendHold(this.reservation, Math.max(this.reservation.hold, Math.ceil(tokens)));
    if (!result.ok) this.blocked = result.reason;
    return result.ok;
  }

  /**
   * A budget callback for runToolLoop / runBuildAgent: records the running total, then holds the
   * size of the round just finished for the next one. Returns a stop message or null.
   */
  budget(model: () => MeteredModel, stream = "main"): (usage: TokenUsage) => Promise<string | null> {
    let lastTotal = 0;
    return async (usage: TokenUsage) => {
      await this.recordCumulative(model(), usage, {}, stream);
      if (this.blocked) return this.stopMessage;
      const total = billableTokens(usage);
      const round = Math.max(1, total - lastTotal);
      lastTotal = total;
      await this.ensureHold(round);
      return this.stopMessage;
    };
  }

  /** Releases whatever hold is left. Unwritten rows are retried first so nothing is lost. */
  async settle(status: "settled" | "failed" = "settled"): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
    await this.flush();
    for (const event of this.queue) {
      // Still unwritten after retries: keep the full event in the logs for manual reconciliation
      // instead of silently dropping real consumption (the hold stays until the stale sweep).
      logger.error("quota_usage_unrecorded", { reservationId: this.reservation?.id, event });
    }
    if (this.queue.length) return;
    await settleReservation(this.reservation, status);
  }

  private async event(model: MeteredModel, usage: TokenUsage, meta: CallMeta): Promise<UsageEvent> {
    const priced = await pricer(model.slug, model.modelId, usage).catch(() => ({ costUsd: null, sellInr: null, priced: false }));
    const zero = usage.promptTokens === 0 && usage.completionTokens === 0;
    return {
      idempotency_key: `${this.reservation?.id ?? "unreserved"}:${++this.seq}`,
      organization_id: this.ctx.organizationId ?? null,
      provider_slug: model.slug,
      model_id: model.modelId,
      input_tokens: usage.promptTokens,
      output_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      cached_tokens: usage.cachedTokens ?? 0,
      cache_write_tokens: usage.cacheWriteTokens ?? 0,
      reasoning_tokens: usage.reasoningTokens ?? 0,
      billable_tokens: meta.chargeable === false ? 0 : billableTokens(usage),
      usage_source: zero ? "none" : usage.estimated ? "estimated" : "provider",
      call_status: meta.status ?? "ok",
      feature: this.ctx.feature,
      conversation_id: this.ctx.conversationId ?? null,
      request_id: meta.requestId ?? null,
      attempt: meta.attempt ?? null,
      streaming: meta.streaming ?? null,
      latency_ms: meta.latencyMs ?? null,
      cost_usd: priced.costUsd,
      sell_inr: priced.sellInr,
      priced: priced.priced,
      estimated_cost_cents: priced.costUsd != null ? Math.round(priced.costUsd * 100 * 100) / 100 : 0,
      meter_version: METER_VERSION,
    };
  }

  private flush(): Promise<boolean> {
    const run = this.chain.then(() => this.flushNow());
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Writes queued rows in order, each with its own key on every attempt. Usage is written even when
   * the balance is already used up (the calls happened); only an unreachable ledger stops the
   * queue. True when nothing is pending and the turn may continue.
   */
  private async flushNow(): Promise<boolean> {
    while (this.queue.length) {
      const event = this.queue[0]!;
      if (!this.reservation) {
        logger.error("quota_unmetered_usage", { userId: this.ctx.userId, event });
        this.queue.shift();
        continue;
      }
      let result: RecordResult | null = null;
      for (let attempt = 1; attempt <= 3 && !result; attempt++) {
        try {
          result = await recordUsage(this.reservation, event);
        } catch (err) {
          if (!(err instanceof QuotaUnavailableError) || attempt === 3) {
            logger.error("quota_record_failed", { reservationId: this.reservation.id, key: event.idempotency_key, error: err instanceof Error ? err.message : String(err) });
            this.blocked = "unavailable";
            return false;
          }
          await new Promise((r) => setTimeout(r, 150 * attempt));
        }
      }
      this.queue.shift();
      if (!result!.duplicate) this.billable += event.billable_tokens;
      if (result!.crossed > 0) {
        try {
          noticeSink(this.ctx.userId, result!.crossed, result!.snapshot?.periodEnd ?? null);
        } catch {
          /* notices are best-effort */
        }
      }
      if (!result!.ok && !this.blocked) this.blocked = result!.reason ?? "exhausted";
    }
    return !this.blocked;
  }
}
