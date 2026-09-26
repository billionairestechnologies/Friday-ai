import assert from "node:assert/strict";
import test from "node:test";
import { nextRunAt, zonedTimeToUtc } from "../src/services/automations/schedule.js";

test("daily run lands on the local wall-clock time (IST, no DST)", () => {
  const after = new Date("2026-09-26T10:00:00Z"); // 15:30 IST
  assert.equal(nextRunAt({ frequency: "daily", timeOfDay: "09:00", timezone: "Asia/Kolkata" }, after).toISOString(), "2026-09-27T03:30:00.000Z");
  assert.equal(nextRunAt({ frequency: "daily", timeOfDay: "18:00", timezone: "Asia/Kolkata" }, after).toISOString(), "2026-09-26T12:30:00.000Z");
});

test("DST-aware: New York 09:00 before and after the November switch", () => {
  assert.equal(zonedTimeToUtc(2026, 10, 30, 9, 0, "America/New_York").toISOString(), "2026-10-30T13:00:00.000Z");
  assert.equal(zonedTimeToUtc(2026, 11, 2, 9, 0, "America/New_York").toISOString(), "2026-11-02T14:00:00.000Z");
});

test("weekdays skip the weekend; weekly hits the chosen weekday", () => {
  const friEvening = new Date("2026-09-25T20:00:00Z"); // Fri 20:00 UTC
  assert.equal(nextRunAt({ frequency: "weekdays", timeOfDay: "08:00", timezone: "UTC" }, friEvening).toISOString(), "2026-09-28T08:00:00.000Z");
  assert.equal(nextRunAt({ frequency: "weekly", timeOfDay: "10:15", weekday: 3, timezone: "UTC" }, friEvening).toISOString(), "2026-09-30T10:15:00.000Z");
});

test("hourly uses local minutes, even in a +05:45 zone", () => {
  const after = new Date("2026-09-26T10:07:30Z");
  assert.equal(nextRunAt({ frequency: "hourly", timeOfDay: "00:30", timezone: "UTC" }, after).toISOString(), "2026-09-26T10:30:00.000Z");
  const kathmandu = nextRunAt({ frequency: "hourly", timeOfDay: "00:00", timezone: "Asia/Kathmandu" }, after);
  assert.equal(kathmandu.toISOString(), "2026-09-26T10:15:00.000Z"); // 16:00 local
});

test("invalid time zones fall back to UTC", () => {
  const after = new Date("2026-09-26T10:00:00Z");
  assert.equal(nextRunAt({ frequency: "daily", timeOfDay: "11:00", timezone: "Mars/Olympus" }, after).toISOString(), "2026-09-26T11:00:00.000Z");
});
