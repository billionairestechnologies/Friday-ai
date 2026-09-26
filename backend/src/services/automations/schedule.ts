/**
 * Next-run computation for automations, in the user's IANA time zone (DST-correct), without a
 * date library: wall-clock times are converted to UTC through Intl's offset for that instant.
 */

export type Frequency = "hourly" | "daily" | "weekdays" | "weekly";

export type Schedule = {
  frequency: Frequency;
  /** "HH:MM" local time (for hourly only the minutes are used). */
  timeOfDay: string;
  /** 0 = Sunday … 6 = Saturday (weekly only). */
  weekday?: number | null;
  timezone: string;
};

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock date/time at `instant` in `tz`. */
export function zonedParts(instant: Date, tz: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const get = (type: string) => fmt.formatToParts(instant).find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** UTC instant for a wall-clock time in `tz` (two passes so DST transitions resolve correctly). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += target - asUtc;
  }
  return new Date(guess);
}

/** First run strictly after `after`. */
export function nextRunAt(schedule: Schedule, after: Date = new Date()): Date {
  const tz = isValidTimeZone(schedule.timezone) ? schedule.timezone : "UTC";
  const [hh, mm] = schedule.timeOfDay.split(":").map(Number) as [number, number];
  if (schedule.frequency === "hourly") {
    const next = new Date(after.getTime());
    next.setUTCSeconds(0, 0);
    // Step on the LOCAL clock: zones like Asia/Kathmandu (+05:45) put local :00 at a different UTC minute.
    for (let i = 1; i <= 61; i++) {
      const candidate = new Date(next.getTime() + i * 60_000);
      if (zonedParts(candidate, tz).minute === mm) return candidate;
    }
    return new Date(after.getTime() + 3_600_000);
  }
  const local = zonedParts(after, tz);
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    const weekday = day.getUTCDay();
    if (schedule.frequency === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (schedule.frequency === "weekly" && weekday !== (schedule.weekday ?? 1)) continue;
    const candidate = zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return new Date(after.getTime() + 86_400_000);
}
