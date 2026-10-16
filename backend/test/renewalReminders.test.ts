import assert from "node:assert/strict";
import test from "node:test";
import { dueReminder, reminderCopy } from "../src/services/billing/renewalReminders.js";

const H = 60 * 60 * 1000;
const now = new Date("2026-10-07T06:00:00Z");
const at = (hours: number) => new Date(now.getTime() + hours * H);

test("3 days and 1 day before the end; nothing once it has passed (the 'ended' note comes from the expiry event)", () => {
  assert.equal(dueReminder(at(100), now), null);
  assert.equal(dueReminder(at(72), now), "3d");
  assert.equal(dueReminder(at(30), now), "3d");
  assert.equal(dueReminder(at(24), now), "1d");
  assert.equal(dueReminder(at(1), now), "1d");
  assert.equal(dueReminder(at(-2), now), null);
});

test("the ended note says the account is on Free now (no grace window)", () => {
  const c = reminderCopy({ kind: "ended", plan: "pro", end: at(-2), scheduledPlan: null, appUrl: "https://x" });
  assert.match(c.subject, /Pro plan has ended/);
  assert.match(c.markdown, /on \*\*Free\*\* now/);
});

test("copy names the plan, the date, and links to /plans", () => {
  const c = reminderCopy({ kind: "3d", plan: "pro", end: at(60), scheduledPlan: null, appUrl: "https://friday.example.com/" });
  assert.match(c.subject, /Pro plan ends in 3 days/);
  assert.equal(c.cta.url, "https://friday.example.com/plans");
  assert.match(c.markdown, /don't renew on their own/);
});

test("a booked lower plan gets 'nothing to do' copy instead of a renew push", () => {
  const c = reminderCopy({ kind: "1d", plan: "premium", end: at(10), scheduledPlan: "pro", appUrl: "https://x" });
  assert.match(c.subject, /Premium plan ends .* Pro starts then/);
  assert.match(c.markdown, /nothing you need to do/);
});
