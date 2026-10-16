import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../../utils/logger.js";
import { estimateTokenUsageFromText, type TokenUsage } from "../tokenUsage.js";
import type { ChatMessage } from "../providers/types.js";
import type { CallMeta, MeteredModel, UsageMeter } from "./usageMeter.js";

/**
 * The turn's UsageMeter, reachable from deep helpers (intent probes, Build's reviewer and
 * summarizer, plan drafting) without threading it through every signature. streamMessage runs the
 * whole turn inside withMeter(); a helper outside any turn just logs that its call went unmetered.
 */
const store = new AsyncLocalStorage<UsageMeter>();

export function withMeter<T>(meter: UsageMeter, fn: () => Promise<T>): Promise<T> {
  return store.run(meter, fn);
}

export function currentMeter(): UsageMeter | undefined {
  return store.getStore();
}

function promptChars(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
}

/**
 * Wraps a non-streaming `adapter.chat()` call — which returns text only, no usage — and records it
 * on the current turn's meter. The usage is ESTIMATED from characters (≈4 per token), flagged
 * `usage_source = estimated` on the ledger row and never presented as exact.
 *
 * `chargeable: false` is for routing overhead the customer didn't ask for (intent and search
 * probes): the row keeps its raw token estimate for our cost reports but bills 0 tokens.
 * The record happens when the CALL finishes, even if a caller's timeout gave up on it first —
 * the provider still billed it.
 */
export async function meteredChat(
  model: MeteredModel,
  messages: ChatMessage[],
  call: () => Promise<string>,
  opts: { chargeable: boolean; meter?: UsageMeter } = { chargeable: true },
): Promise<string> {
  const meter = opts.meter ?? currentMeter();
  const started = Date.now();
  const record = (usage: TokenUsage, meta: CallMeta) => {
    if (!meter) {
      logger.warn("quota_unmetered_helper_call", { provider: model.slug, model: model.modelId });
      return;
    }
    void meter.recordCall(model, usage, { ...meta, chargeable: opts.chargeable, streaming: false, latencyMs: Date.now() - started }).catch(() => undefined);
  };
  try {
    const text = await call();
    record(estimateTokenUsageFromText(promptChars(messages), text.length), { status: "ok" });
    return text;
  } catch (err) {
    // An HTTP-level failure (rejected request, 5xx before any output) is recorded with no tokens.
    record({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }, { status: "failed" });
    throw err;
  }
}
