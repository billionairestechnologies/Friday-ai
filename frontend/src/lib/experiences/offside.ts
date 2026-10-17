/**
 * Football offside — a deterministic, simplified model of IFAB Law 11 (no LLM involved). Positions
 * are metres along the pitch length, attacking towards x = 105 (the opponents' goal line); the
 * halfway line is x = 52.5. All comparisons use positions rounded to 0.1 m, so "level" is exact.
 *
 * Offside POSITION (Law 11.1): in the opponents' half (not on the halfway line) AND nearer to the
 * opponents' goal line than BOTH the ball and the second-last opponent. Level with either = onside.
 * Offside OFFENCE (Law 11.2–11.3): in an offside position when a team-mate plays the ball AND then
 * involved in active play — and never directly from a goal kick, throw-in or corner kick.
 *
 * Simplifications (said in the UI): one point per player (real decisions use the furthest part of
 * the head, body or feet that can legally play the ball; arms don't count), positions are taken at
 * the moment the ball is played, and "involved in active play" is a yes/no the user sets.
 */

export const PITCH_LENGTH = 105;
export const PITCH_WIDTH = 68;
export const HALFWAY = PITCH_LENGTH / 2;

export type Restart = "open_play" | "goal_kick" | "throw_in" | "corner_kick";

export type OffsideInput = {
  receiverX: number;
  /** Every opponent's x (goalkeeper included). */
  opponentsX: number[];
  ballX: number;
  involvedInPlay: boolean;
  restart: Restart;
};

export type OffsideReason = "own_half" | "behind_or_level_with_ball" | "level_with_second_last" | "behind_second_last" | "beyond";

export type OffsideResult = {
  inOffsidePosition: boolean;
  offence: boolean;
  reason: OffsideReason;
  /** The line that matters: the second-last opponent or the ball, whichever is nearer the goal line. */
  offsideLineX: number;
  secondLastX: number;
  /** + = metres beyond the offside line (offside side), − = metres onside, 0 = level. */
  margin: number;
  explanation: string;
  offenceExplanation: string;
};

const q = (x: number) => Math.round(x * 10) / 10;
const clamp = (x: number) => Math.min(PITCH_LENGTH, Math.max(0, x));

export function secondLastOpponent(opponentsX: number[]): number {
  // Nearest to their goal line first; with fewer than two opponents the goal line itself stands in.
  const xs = opponentsX.map((x) => q(clamp(x))).sort((a, b) => b - a);
  return xs.length >= 2 ? xs[1]! : PITCH_LENGTH;
}

const fmt = (m: number) => `${Math.abs(m).toFixed(1)} m`;

export function evaluateOffside(input: OffsideInput): OffsideResult {
  const receiver = q(clamp(input.receiverX));
  const ball = q(clamp(input.ballX));
  const secondLast = secondLastOpponent(input.opponentsX);
  const line = Math.max(secondLast, ball);
  const margin = q(receiver - line);

  let reason: OffsideReason;
  if (receiver <= HALFWAY) reason = "own_half";
  else if (receiver <= ball) reason = "behind_or_level_with_ball";
  else if (receiver === secondLast) reason = "level_with_second_last";
  else if (receiver < secondLast) reason = "behind_second_last";
  else reason = "beyond";
  const inOffsidePosition = reason === "beyond";

  const explanation = {
    own_half: "Onside: the receiver is in their own half (the halfway line counts as their own half), so they can't be in an offside position.",
    behind_or_level_with_ball: "Onside: the receiver is level with or behind the ball, so they can't be in an offside position.",
    level_with_second_last: "Onside: the receiver is exactly level with the second-last opponent. Level is onside.",
    behind_second_last: `Onside: the receiver is ${fmt(secondLast - receiver)} behind the second-last opponent.`,
    beyond: `Offside position: the receiver is ${fmt(margin)} nearer the goal line than both the ball and the second-last opponent.`,
  }[reason];

  const exempt = input.restart !== "open_play";
  const offence = inOffsidePosition && input.involvedInPlay && !exempt;
  const restartName = { open_play: "", goal_kick: "a goal kick", throw_in: "a throw-in", corner_kick: "a corner kick" }[input.restart];
  const offenceExplanation = !inOffsidePosition
    ? "No offence: an onside player can't commit an offside offence."
    : exempt
      ? `No offence: there's no offside offence when receiving the ball directly from ${restartName}.`
      : !input.involvedInPlay
        ? "No offence yet: being in an offside position isn't an offence by itself — only becoming involved in active play (playing the ball, interfering with an opponent, or gaining an advantage) is."
        : "Offence: in an offside position when the ball was played, and then involved in active play. The referee awards an indirect free kick to the defending team.";

  return { inOffsidePosition, offence, reason, offsideLineX: line, secondLastX: secondLast, margin, explanation, offenceExplanation };
}

export type OffsideParams = { receiverX: number; defenderX: number; goalkeeperX: number; ballX: number; involvedInPlay: boolean; restart: Restart };

export const OFFSIDE_DEFAULTS: OffsideParams = { receiverX: 80, defenderX: 82, goalkeeperX: 101, ballX: 60, involvedInPlay: true, restart: "open_play" };

/** Bounds-checks params from anywhere (a URL, a model's answer); null = reject. */
export function parseOffsideParams(raw: unknown): OffsideParams | null {
  if (raw == null) return { ...OFFSIDE_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out = { ...OFFSIDE_DEFAULTS };
  for (const k of ["receiverX", "defenderX", "goalkeeperX", "ballX"] as const) {
    if (r[k] === undefined) continue;
    const v = Number(r[k]);
    if (!Number.isFinite(v) || v < 0 || v > PITCH_LENGTH) return null;
    out[k] = q(v);
  }
  if (r.involvedInPlay !== undefined) {
    if (typeof r.involvedInPlay !== "boolean") return null;
    out.involvedInPlay = r.involvedInPlay;
  }
  if (r.restart !== undefined) {
    if (!["open_play", "goal_kick", "throw_in", "corner_kick"].includes(r.restart as string)) return null;
    out.restart = r.restart as Restart;
  }
  return out;
}
