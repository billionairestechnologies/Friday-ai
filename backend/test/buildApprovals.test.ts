import assert from "node:assert/strict";
import test from "node:test";
import { approvalFor, hasPendingApproval, listPendingApprovals, requestApproval, resolveApproval } from "../src/services/projectBuild/approvals.js";

const run = (cmd: string) => ({ kind: "run" as const, desc: "", cmd });

test("full auto runs sandbox work without asking", () => {
  assert.equal(approvalFor(run("npm install"), "full_auto"), null);
  assert.equal(approvalFor({ kind: "write", path: "a.ts", content: "" }, "full_auto"), null);
  assert.equal(approvalFor({ kind: "ext", tool: "github_x", args: {} }, "full_auto"), null);
});

test("auto_edit asks for commands and connectors, not file edits", () => {
  assert.ok(approvalFor(run("npm install"), "auto_edit"));
  assert.ok(approvalFor({ kind: "ext", tool: "gmail_send", args: {} }, "auto_edit"));
  assert.equal(approvalFor({ kind: "edit", path: "a.ts", edits: [] }, "auto_edit"), null);
  assert.equal(approvalFor({ kind: "read", path: "a.ts" }, "auto_edit"), null);
});

test("ask mode asks for file changes too", () => {
  assert.equal(approvalFor({ kind: "write", path: "a.ts", content: "" }, "ask")?.kind, "file");
});

test("pull requests, deploys and recursive deletes always ask", () => {
  assert.equal(approvalFor({ kind: "pr", title: "t", branch: "b", body: "" }, "full_auto")?.always, true);
  for (const cmd of ["rm -rf src", "git push origin main", "npx vercel deploy --prod", "npm publish", "netlify deploy --prod"]) {
    assert.equal(approvalFor(run(cmd), "full_auto")?.always, true, cmd);
  }
  assert.equal(approvalFor(run("rm package-lock.json"), "full_auto"), null);
});

test("a pending request resolves with the user's decision, only for its owner", async () => {
  const { request, decision } = requestApproval("conv-1", "user-1", { kind: "command", title: "Run: npm test" });
  assert.equal(hasPendingApproval("conv-1"), true);
  assert.equal(listPendingApprovals("conv-1", "user-2").length, 0);
  assert.equal(resolveApproval("conv-1", "user-2", request.id, "allow"), false);
  assert.equal(resolveApproval("conv-1", "user-1", request.id, "allow_all"), true);
  assert.equal(await decision, "allow_all");
  assert.equal(hasPendingApproval("conv-1"), false);
});

test("stopping the build denies a waiting request", async () => {
  const ac = new AbortController();
  const { decision } = requestApproval("conv-2", "user-1", { kind: "command", title: "Run: x" }, ac.signal);
  ac.abort();
  assert.equal(await decision, "deny");
  assert.equal(hasPendingApproval("conv-2"), false);
});
