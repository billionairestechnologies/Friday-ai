/**
 * Age-banded one-liners shown next to the typing dots while a reply is still on its way. Self-
 * contained on purpose — if this doesn't work out, delete this file and the two call sites that
 * import it (message-thread.tsx's waiting pill, and nothing else) with no other cleanup needed.
 *
 * Deliberately short: the "thinking" window is usually 1-3 seconds, not long enough to read a
 * sentence, let alone an article — so these are quick one-liners from a small pool, not fetched
 * content that could be slow or arrive after the real reply already lands.
 */

type AgeBand = "teen" | "twenties" | "thirties_plus";

const GENERIC_LINES = [
  "Thinking…",
  "Working on it…",
  "One sec…",
  "Putting this together…",
];

const BAND_LINES: Record<AgeBand, string[]> = {
  teen: [
    "Cooking up something good…",
    "Locked in…",
    "Give me a sec…",
  ],
  twenties: [
    "On it…",
    "Pulling this together…",
    "Almost there…",
  ],
  thirties_plus: [
    "Working through it…",
    "One moment…",
    "Getting this right…",
  ],
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

/** Picks one line, weighted toward the user's age band when a birthday is on file. */
export function pickThinkingLine(birthday?: string | null): string {
  const age = birthday ? ageFromBirthday(birthday) : null;
  const band = age !== null ? bandForAge(age) : null;
  const pool = band ? [...BAND_LINES[band], ...GENERIC_LINES] : GENERIC_LINES;
  return pool[Math.floor(Math.random() * pool.length)]!;
}
