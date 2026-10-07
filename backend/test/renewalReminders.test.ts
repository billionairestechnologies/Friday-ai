import assert from "node:assert/strict";
import test from "node:test";
import { dueReminder, reminderCopy } from "../src/services/billing/renewalReminders.js";

const H = 60 * 60 * 1000;
const now = new Date("2026-10-07T06:00:00Z");
const at = (hours: number) => new Date(now.getTime() + hours * H);

test("3 days, 1 day and just-ended windows", () => {
  assert.equal(dueReminder(at(100), now, 24 * H), null);
  assert.equal(dueReminder(at(72), now, 24 * H), "3d");
  assert.equal(dueReminder(at(30), now, 24 * H), "3d");
  assert.equal(dueReminder(at(24), now, 24 * H), "1d");
  assert.equal(dueReminder(at(1), now, 24 * H), "1d");
  assert.equal(dueReminder(at(-2), now, 24 * H), "ended");
  assert.equal(dueReminder(at(-30), now, 24 * H), null); // past grace: already Free, nothing to say
});

test("copy names the plan, the date, and links to /plans", () => {
  const c = reminderCopy({ kind: "3d", plan: "pro", end: at(60), scheduledPlan: null, graceHours: 24, appUrl: "https://friday.example.com/" });
  assert.match(c.subject, /Pro plan ends in 3 days/);
  assert.equal(c.cta.url, "https://friday.example.com/plans");
  assert.match(c.markdown, /don't renew on their own/);
});

test("a booked lower plan gets 'nothing to do' copy instead of a renew push", () => {
  const c = reminderCopy({ kind: "1d", plan: "premium", end: at(10), scheduledPlan: "pro", graceHours: 24, appUrl: "https://x" });
  assert.match(c.subject, /Premium plan ends .* Pro starts then/);
  assert.match(c.markdown, /nothing you need to do/);
});
