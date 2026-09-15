import { useEffect, useState } from "react";

function greetingForHour(hour: number): string {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Good night";
}

export function useGreeting(): string {
  const [greeting, setGreeting] = useState(() => greetingForHour(new Date().getHours()));

  useEffect(() => {
    const id = window.setInterval(() => {
      setGreeting(greetingForHour(new Date().getHours()));
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  return greeting;
}

// Friendly, generic openers mixed in alongside the time-of-day greeting so the dashboard doesn't
// say the exact same thing on every visit.
const FRIENDLY_LINES = [
  "What can I do for you today?",
  "What's on your mind?",
  "Ready when you are.",
  "What should we work on?",
  "How can I help today?",
  "What are we building today?",
];

export type HeroLine = { kind: "greeting"; greeting: string; name?: string } | { kind: "line"; text: string };

/**
 * Picks the dashboard's headline once per visit — the time-of-day greeting (with the user's
 * name) most of the time, occasionally a friendly generic line instead, for variety. Stable
 * for the lifetime of the mount so it doesn't shuffle mid-visit.
 */
export function useHeroLine(greeting: string, name?: string): HeroLine {
  const [line] = useState<HeroLine>(() => {
    // Weighted so the personal greeting still shows more often than not.
    const pool: HeroLine[] = [
      { kind: "greeting", greeting, name },
      { kind: "greeting", greeting, name },
      ...FRIENDLY_LINES.map((text): HeroLine => ({ kind: "line", text })),
    ];
    return pool[Math.floor(Math.random() * pool.length)]!;
  });
  return line;
}
