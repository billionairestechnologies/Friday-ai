/**
 * Runaway protection for agent loops. A model stuck in a rut re-issues the same tool call(s) round
 * after round (a failing command, a file it keeps re-reading) and every round re-sends the whole
 * transcript — the fastest way to burn a user's usage for nothing. Identical consecutive rounds are
 * the signal: after `maxRepeats` in a row the loop stops, the work stays saved, and the user is told.
 * Pure + shared by the chat tool loop and the Build agent.
 */
export const LOOP_STOP_MESSAGE =
  "I kept repeating the same step without getting anywhere, so I stopped to avoid wasting your usage. Tell me what to change and I'll try a different approach.";

/** Per-turn spend ceiling message (one turn used a very large share of the month's allowance). */
export const TURN_CAP_MESSAGE =
  "This task used a large share of your usage in one go, so I paused here. Your work is saved — say \"continue\" to carry on.";

/**
 * Share of the monthly allowance one turn may spend before it pauses. A runaway guard, not a usage
 * cap: the user can say "continue" and spend the rest the same day (Pro: 3M tokens ≈ a dozen
 * long Build turns' worth in ONE turn before it asks).
 */
export const TURN_CAP_SHARE = 0.3;

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

/** The billable tokens one turn may spend before pausing; none when the allowance is unknown. */
export function turnTokenCap(allowance: number | undefined | null): number | null {
  return allowance && allowance > 0 ? Math.floor(allowance * TURN_CAP_SHARE) : null;
}
