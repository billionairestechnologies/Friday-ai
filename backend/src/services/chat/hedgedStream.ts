import { getProviderAdapter } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { getWorkingKeyForProvider, type ChatCandidate } from "../providerService.js";
import { invalidateMemoized } from "../../utils/ttlMemo.js";
import type { TokenUsage } from "../tokenUsage.js";

/**
 * Streams a reply from an ordered list of candidate models, with two latency protections:
 *
 *  1. Failover — if a candidate errors before producing anything, the next one is tried (as before).
 *  2. Hedging — provider time-to-first-token is heavy-tailed (measured 1.5s typical, 5s+ on a bad
 *     call). If the first candidate hasn't produced a token after `hedgeAfterMs`, the next candidate is
 *     started in parallel; whichever emits a token first wins and the other is aborted. This trims the
 *     slow tail without slowing the fast path, and costs nothing when the first candidate is quick.
 *
 * Only ever forwards output from the winner, so the client never sees two overlapping replies.
 */
export type HedgedResult = {
  candidate: ChatCandidate | null;
  text: string;
  thinking: string;
  usage: TokenUsage | null;
  lastError?: string;
  hedged: boolean;
};

type Attempt = {
  candidate: ChatCandidate;
  controller: AbortController;
  started: boolean;
  text: string;
  thinking: string;
  usage: TokenUsage | null;
  promise: Promise<void>;
  error?: string;
  finished: boolean;
};

export async function streamWithHedging(opts: {
  candidates: ChatCandidate[];
  history: ChatMessage[];
  cacheKey: string;
  signal?: AbortSignal;
  /** 0 disables hedging (single-model conversations have nothing to hedge with). */
  hedgeAfterMs: number;
  onText: (delta: string) => void;
  onThink: (delta: string) => void;
  /** Injection points for tests; default to the real provider registry / key store. */
  deps?: {
    getAdapter: (slug: string) => ReturnType<typeof getProviderAdapter>;
    getKey: (slug: string) => Promise<string>;
  };
}): Promise<HedgedResult> {
  const getAdapter = opts.deps?.getAdapter ?? getProviderAdapter;
  const getKey = opts.deps?.getKey ?? getWorkingKeyForProvider;
  const { candidates, history, cacheKey, signal, hedgeAfterMs } = opts;
  let winner: Attempt | null = null;
  let nextIndex = 0;
  let lastError: string | undefined;
  let hedged = false;
  const active = new Set<Attempt>();

  const launch = (candidate: ChatCandidate): Attempt => {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    const attempt: Attempt = {
      candidate,
      controller,
      started: false,
      text: "",
      thinking: "",
      usage: null,
      finished: false,
      promise: Promise.resolve(),
    };

    // Called on this attempt's first output. The first attempt to speak becomes the winner and every
    // other in-flight attempt is cancelled.
    const claim = (): boolean => {
      if (!winner) {
        winner = attempt;
        for (const other of active) if (other !== attempt) other.controller.abort();
      }
      return winner === attempt;
    };

    attempt.promise = (async () => {
      try {
        const adapter = getAdapter(candidate.slug);
        const apiKey = await getKey(candidate.slug);
        if (adapter.chatStream) {
          attempt.text = await adapter.chatStream(
            apiKey,
            candidate.modelId,
            history,
            (delta) => {
              if (!claim()) return;
              attempt.started = true;
              opts.onText(delta);
            },
            controller.signal,
            (delta) => {
              if (!claim()) return;
              attempt.started = true;
              attempt.thinking += delta;
              opts.onThink(delta);
            },
            (usage) => {
              attempt.usage = usage;
            },
            { cacheKey },
          );
        } else {
          attempt.text = await adapter.chat(apiKey, candidate.modelId, history, { cacheKey });
          if (claim()) {
            attempt.started = true;
            opts.onText(attempt.text);
          }
        }
      } catch (err) {
        attempt.error = `${candidate.slug}: ${err instanceof Error ? err.message : "failed"}`;
        // A rejected key (rotated/revoked) must not keep being served from the lookup cache.
        if (/\b(401|403)\b|invalid.{0,20}(api )?key|unauthori[sz]ed/i.test(attempt.error)) invalidateMemoized();
      } finally {
        attempt.finished = true;
        signal?.removeEventListener("abort", onOuterAbort);
      }
    })();
    active.add(attempt);
    return attempt;
  };

  launch(candidates[nextIndex++]!);
  let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
  const armHedge = () => {
    if (hedgeAfterMs <= 0 || hedgeTimer || winner || nextIndex >= candidates.length) return;
    hedgeTimer = setTimeout(() => {
      hedgeTimer = null;
      if (!winner && !signal?.aborted && nextIndex < candidates.length) {
        hedged = true;
        launch(candidates[nextIndex++]!);
      }
    }, hedgeAfterMs);
  };
  armHedge();

  try {
    for (;;) {
      // Wait for any attempt to settle (or for the hedge timer to add one).
      await Promise.race([...active].map((a) => a.promise.then(() => a)).concat([new Promise<Attempt>((r) => setTimeout(() => r(null as never), 100))]));

      if (winner) {
        const w: Attempt = winner;
        await w.promise; // the rest of the reply streams through the winner's callbacks
        if (w.error) return { candidate: null, text: "", thinking: w.thinking, usage: null, lastError: w.error, hedged };
        return { candidate: w.candidate, text: w.text, thinking: w.thinking, usage: w.usage, hedged };
      }

      // No winner yet: reap failed attempts, and start the next candidate if nothing is left running.
      for (const a of [...active]) {
        if (a.finished) {
          active.delete(a);
          if (a.error) lastError = a.error;
        }
      }
      if (active.size === 0) {
        if (signal?.aborted || nextIndex >= candidates.length) {
          return { candidate: null, text: "", thinking: "", usage: null, lastError, hedged };
        }
        launch(candidates[nextIndex++]!);
      }
      armHedge();
    }
  } finally {
    if (hedgeTimer) clearTimeout(hedgeTimer);
    for (const a of active) if (a !== winner) a.controller.abort();
  }
}
