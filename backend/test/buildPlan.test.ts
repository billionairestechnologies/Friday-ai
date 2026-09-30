import assert from "node:assert/strict";
import test from "node:test";
import { PLAN_APPROVE_TEXT, approvedPlanNote, isPlanApproval, needsPlan, renderPlan } from "../src/services/projectBuild/plan.js";
import type { BuildPlan } from "../src/services/chat/types.js";

test("isPlanApproval accepts the Approve button and a plain yes", () => {
  assert.equal(isPlanApproval(PLAN_APPROVE_TEXT), true);
  for (const t of ["yes", "Yes!", "ok", "looks good", "LGTM", "go ahead", "build it", "start building", "sounds good, proceed"]) {
    assert.equal(isPlanApproval(t), true, t);
  }
});

test("isPlanApproval treats anything asking for a change as feedback", () => {
  for (const t of [
    "yes but use Vue instead",
    "ok, add a login page",
    "looks good, remove the blog",
    "use Next.js",
    "can you make it dark themed?",
    "no",
    "go ahead and also add Stripe payments to the checkout with subscriptions and invoices",
  ]) {
    assert.equal(isPlanApproval(t), false, t);
  }
});

test("needsPlan: new projects and big changes get a plan, small follow-ups don't", () => {
  assert.equal(needsPlan(0, "run it"), true); // nothing built yet → always plan
  assert.equal(needsPlan(0, "Build a Kanban board with drag and drop"), true);
  assert.equal(needsPlan(12, "fix the header colour"), false);
  assert.equal(needsPlan(12, "run it"), false);
  assert.equal(needsPlan(12, "add a new login page with Google sign-in"), true);
  assert.equal(needsPlan(12, "redesign the dashboard"), true);
  assert.equal(needsPlan(12, "x".repeat(200)), true); // long request = real work
});

test("renderPlan / approvedPlanNote include every part of the plan", () => {
  const plan: BuildPlan = {
    summary: "A Kanban board with three columns",
    architecture: "Vite + React, localStorage",
    items: [
      { text: "Scaffold the Vite app", state: "todo" },
      { text: "Run it, verify it in a browser and fix any issues", state: "todo" },
    ],
    status: "pending",
  };
  const text = renderPlan(plan);
  assert.match(text, /What I'll build:\nA Kanban board/);
  assert.match(text, /Architecture:\nVite \+ React/);
  assert.match(text, /- \[ \] Scaffold the Vite app/);
  assert.match(approvedPlanNote(plan), /APPROVED PLAN/);
  // No summary (older plan shape) is fine.
  assert.doesNotMatch(renderPlan({ ...plan, summary: undefined }), /What I'll build/);
});
