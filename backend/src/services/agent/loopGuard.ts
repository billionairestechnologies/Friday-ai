/**
 * Runaway protection for agent loops. A model stuck in a rut re-issues the same tool call(s) round
 * after round (a failing command, a file it keeps re-reading) and every round re-sends the whole
 * transcript — the fastest way to burn a user's usage for nothing. Identical consecutive rounds are
 * the signal: after `maxRepeats` in a row the loop stops, the work stays saved, and the user is told.
 * Pure + shared by the chat tool loop and the Build agent.
 */
export const LOOP_STOP_MESSAGE =
  "I kept repeating the same step without getting anywhere, so I stopped to avoid wasting your usage. Tell me what to change and I'll try a different approach.";

/** Per-turn spend ceiling message (the turn used a very large share of the user's 5-hour window). */
export const TURN_CAP_MESSAGE =
  "This task used a large share of your usage in one go, so I paused here. Your work is saved — say \"continue\" to carry on.";

/** Share of the user's 5-hour window one turn may spend before it pauses. */
export const TURN_CAP_SHARE = 0.8;

/** Stable key for one round of tool calls: names + arguments, order-independent, key-order-independent. */
export function roundSignature(calls: Array<{ name: string; args?: unknown }>): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)]))
        : v;
  return calls
    .map((c) => `${c.name}:${JSON.stringify(canon(c.args ?? {}))}`)
    .sort()
    .join("|");
}

export class LoopGuard {
  private last = "";
  private repeats = 0;
  constructor(private readonly maxRepeats = 3) {}

  /** Records a round; true = the same round has now happened `maxRepeats` times in a row → stop. */
  record(calls: Array<{ name: string; args?: unknown }>): boolean {
    const sig = roundSignature(calls);
    this.repeats = sig === this.last ? this.repeats + 1 : 1;
    this.last = sig;
    return this.repeats >= this.maxRepeats;
  }
}

/** The credits one turn may spend: a share of the 5-hour window; no cap when the plan has no such window (org pools). */
export function turnCreditCap(rollingLimit: number | undefined | null): number | null {
  return rollingLimit && rollingLimit > 0 ? Math.floor(rollingLimit * TURN_CAP_SHARE) : null;
}
