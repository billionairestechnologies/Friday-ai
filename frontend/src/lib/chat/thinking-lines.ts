/**
 * Age-banded, mode-aware one-liners shown next to the typing dots while a reply is still on its
 * way. Self-contained on purpose — if this doesn't work out, delete this file and the two call
 * sites that import it (message-thread.tsx's waiting pill, and nothing else) with no other
 * cleanup needed.
 *
 * Deliberately short flavor text, not real fetched content: the waiting window is usually 1-3
 * seconds, not long enough to read a sentence let alone an article, and pulling in live news
 * would add latency/cost to the thing this is trying to fill dead time for. These just sound
 * newsy/thinky depending on mode — they aren't real headlines.
 */

import { useEffect, useState } from "react";

type AgeBand = "teen" | "twenties" | "thirties_plus";
/** Mirrors ChatMessage["status"] — "working" covers plain replies and the null/no-status case.
 *  "canvas" is for the Canvas-build step log (writing code), not a status value. */
export type ThinkingMode = "working" | "thinking" | "searching" | "canvas";

const WORKING_GENERIC = ["Thinking…", "Working on it…", "One sec…", "Putting this together…"];

const WORKING_BAND: Record<AgeBand, string[]> = {
  teen: ["Cooking up something good…", "Locked in…", "Give me a sec…"],
  twenties: ["On it…", "Pulling this together…", "Almost there…"],
  thirties_plus: ["Working through it…", "One moment…", "Getting this right…"],
};

// "Think" mode — reasoning-flavored, with a bit of personality (per feedback: "funny and crazy
// talks, just interesting things" — not just a dry status label).
const THINKING_GENERIC = [
  "Reasoning through it…",
  "Connecting the dots…",
  "Weighing a few angles…",
  "Working the logic…",
];

const THINKING_BAND: Record<AgeBand, string[]> = {
  teen: ["Big brain mode, activated…", "Overthinking this on purpose…", "Running the numbers…"],
  twenties: ["Mapping this out…", "Untangling this properly…", "Working through the angles…"],
  thirties_plus: ["Reasoning carefully…", "Thinking it through properly…", "Working the problem…"],
};

const THINKING_FUN = [
  "Consulting my inner monologue…",
  "Doing some mental gymnastics…",
  "Turning this over a few times…",
  "Debating myself about it…",
];

// "Search" mode — news/web-flavored.
const SEARCHING_GENERIC = [
  "Scanning the web…",
  "Checking a few sources…",
  "Cross-referencing results…",
  "Digging through search results…",
];

const SEARCHING_BAND: Record<AgeBand, string[]> = {
  teen: ["Doomscrolling for you…", "Stalking the internet for answers…", "Snooping around online…"],
  twenties: ["Deep-diving the internet…", "Pulling receipts from the web…", "Fact-checking live…"],
  thirties_plus: ["Consulting a few sources…", "Checking today's coverage…", "Verifying the details…"],
};

const SEARCHING_FUN = [
  "Googling harder than you ever have…",
  "Being nosy on your behalf…",
  "Reading the internet's fine print…",
  "Chasing down the latest on this…",
];

// "Canvas" mode — writing/building-flavored, for the live code-generation step log.
const CANVAS_GENERIC = [
  "Writing the code…",
  "Laying out the structure…",
  "Wiring it together…",
  "Putting the pieces together…",
];

const CANVAS_BAND: Record<AgeBand, string[]> = {
  teen: ["Building it out…", "Making it look clean…", "Getting the details right…"],
  twenties: ["Shipping this…", "Building it properly…", "Getting the layout right…"],
  thirties_plus: ["Building this out carefully…", "Getting the structure right…", "Assembling the pieces…"],
};

const CANVAS_FUN = [
  "Making it pixel-perfect…",
  "Sweating the small details…",
  "Making this actually work…",
];

const MODE_POOLS: Record<ThinkingMode, { generic: string[]; band: Record<AgeBand, string[]>; fun: string[] }> = {
  working: { generic: WORKING_GENERIC, band: WORKING_BAND, fun: [] },
  thinking: { generic: THINKING_GENERIC, band: THINKING_BAND, fun: THINKING_FUN },
  searching: { generic: SEARCHING_GENERIC, band: SEARCHING_BAND, fun: SEARCHING_FUN },
  canvas: { generic: CANVAS_GENERIC, band: CANVAS_BAND, fun: CANVAS_FUN },
};

function ageFromBirthday(birthday: string): number | null {
  const parsed = new Date(birthday);
  if (Number.isNaN(parsed.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - parsed.getFullYear();
  const beforeBirthdayThisYear =
    now.getMonth() < parsed.getMonth() ||
    (now.getMonth() === parsed.getMonth() && now.getDate() < parsed.getDate());
  if (beforeBirthdayThisYear) age -= 1;
  return age;
}

function bandForAge(age: number): AgeBand | null {
  if (age < 13 || age > 110) return null; // implausible — fall back to generic rather than guess
  if (age < 20) return "teen";
  if (age < 30) return "twenties";
  return "thirties_plus";
}

/** Picks one line for the given mode, weighted toward the user's age band when a birthday is on file. */
export function pickThinkingLine(birthday?: string | null, mode: ThinkingMode = "working"): string {
  const age = birthday ? ageFromBirthday(birthday) : null;
  const band = age !== null ? bandForAge(age) : null;
  const { generic, band: bandLines, fun } = MODE_POOLS[mode];
  const pool = band ? [...bandLines[band], ...fun, ...generic] : [...fun, ...generic];
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * Rotates through the pool every `intervalMs` while `active` is true, so the wait feels alive
 * instead of a single static line sitting there for however long the reply takes. Resets
 * naturally each time — a fresh assistant message mounts a fresh AssistantBlock, so this hook's
 * state (and thus its first line) starts over per turn without any extra reset logic.
 */
export function useRotatingThinkingLine(
  active: boolean,
  birthday?: string | null,
  mode: ThinkingMode = "working",
  intervalMs = 2600,
): string {
  const [line, setLine] = useState(() => pickThinkingLine(birthday, mode));

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      setLine((prev) => {
        // Avoid an immediate repeat so the rotation actually reads as movement.
        let next = pickThinkingLine(birthday, mode);
        for (let i = 0; next === prev && i < 5; i++) next = pickThinkingLine(birthday, mode);
        return next;
      });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [active, birthday, mode, intervalMs]);

  // Mode can change identity between renders of the same waiting turn (status flips from
  // "working" to "thinking"/"searching" shortly after the request starts) — jump immediately
  // instead of waiting out the rest of the interval on the wrong mode's pool.
  useEffect(() => {
    if (active) setLine(pickThinkingLine(birthday, mode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return line;
}

/** "Working for Ns" — a live elapsed-time counter while `active`, matching the running timer on
 *  Grok's own step log. Resets to 0 each time `active` goes from false to true (a fresh turn). */
export function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) return;
    setSeconds(0);
    const start = Date.now();
    const id = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [active]);

  return seconds;
}

/**
 * A simulated completion percentage for image generation — there is no real progress signal
 * from the image API (it's one blocking call that either returns a finished image or fails), so
 * this fakes a decelerating climb the same way most "AI is generating..." UIs do (Gemini's own
 * included): fast at first, slowing as it approaches the ceiling, and never actually reaching
 * 100 until the real result arrives and the caller stops rendering this state.
 *
 * Derived purely from real elapsed time since `since` (live-stream.ts's `statusSince`, which lives
 * in a module-level Map, not component state) rather than accumulated in a local counter. Confirmed
 * live: the old version used `useState` + `setInterval` seeded at 0 on mount, so switching to
 * another chat while an image was generating and back unmounted/remounted this component and the
 * percentage visibly restarted from 0% — even though the actual generation (tracked server-side and
 * in live-stream.ts) never restarted. Being a pure function of wall-clock time fixes that: whatever
 * `since` the remounted component reads, the percentage picks up from the correct, continuous value.
 */
function pctForElapsed(elapsedMs: number, ceiling: number): number {
  if (elapsedMs <= 0) return 0;
  // Closed form of the old recurrence pct += (ceiling - pct) * 0.08 every 220ms.
  const steps = elapsedMs / 220;
  return Math.round(ceiling * (1 - Math.pow(0.92, steps)));
}

export function useSimulatedProgress(active: boolean, since?: number, ceiling = 92): number {
  const [, forceTick] = useState(0);
  const start = since ?? Date.now();

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => forceTick((n) => n + 1), 220);
    return () => window.clearInterval(id);
  }, [active]);

  if (!active) return 0;
  return Math.min(ceiling, pctForElapsed(Date.now() - start, ceiling));
}
