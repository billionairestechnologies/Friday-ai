import assert from "node:assert/strict";
import test from "node:test";
import { ActionParser, applySearchReplace, compactAssistantTurn, parseSearchReplace, type BuildAction } from "../src/services/projectBuild/protocol.js";
import { branchNameFor, findGitHubRepoUrl } from "../src/services/projectBuild/github.js";

function parseAll(text: string, chunk = 7): BuildAction[] {
  const actions: BuildAction[] = [];
  const parser = new ActionParser(() => {}, (a) => actions.push(a));
  for (let i = 0; i < text.length; i += chunk) parser.feed(text.slice(i, i + chunk));
  parser.end();
  return actions;
}

test("edit/grep/ls/pr tags parse from a streamed reply", () => {
  const reply = [
    "Looking around.",
    '<friday-ls path="src"/>',
    '<friday-grep pattern="use(State|Effect)" path="src"/>',
    '<friday-edit path="src/App.jsx">',
    "<<<<<<< SEARCH",
    "  const a = 1;",
    "=======",
    "  const a = 2;",
    ">>>>>>> REPLACE",
    "<<<<<<< SEARCH",
    "old",
    "=======",
    ">>>>>>> REPLACE",
    "</friday-edit>",
    '<friday-pr title="Bump a" branch="friday/bump">Changes a to 2.</friday-pr>',
  ].join("\n");
  const actions = parseAll(reply);
  assert.deepEqual(actions[0], { kind: "ls", path: "src" });
  assert.deepEqual(actions[1], { kind: "grep", pattern: "use(State|Effect)", path: "src" });
  assert.deepEqual(actions[2], {
    kind: "edit",
    path: "src/App.jsx",
    edits: [
      { search: "  const a = 1;", replace: "  const a = 2;" },
      { search: "old", replace: "" },
    ],
  });
  assert.deepEqual(actions[3], { kind: "pr", title: "Bump a", branch: "friday/bump", body: "Changes a to 2." });
  const malformed = parseAll('<friday-edit path="x.js">just text</friday-edit>');
  assert.equal(malformed[0]!.kind, "malformed");
});

test("applySearchReplace: exact, trailing-whitespace tolerant, ambiguous and missing", () => {
  const file = "function a() {\n  return 1;   \n}\nfunction b() {\n  return 1;\n}\n";
  const ok = applySearchReplace(file, [{ search: "function a() {\n  return 1;\n}", replace: "function a() {\n  return 42;\n}" }]);
  assert.equal(ok.ok, true);
  assert.match((ok as { content: string }).content, /return 42;[\s\S]*function b\(\) \{\n  return 1;/);

  const ambiguous = applySearchReplace(file.replace("1;   ", "1;"), [{ search: "  return 1;", replace: "x" }]);
  assert.equal(ambiguous.ok, false);
  assert.match((ambiguous as { error: string }).error, /more than once/);

  const missing = applySearchReplace(file, [{ search: "nope", replace: "x" }]);
  assert.equal(missing.ok, false);
  assert.match((missing as { error: string }).error, /not found/);

  const chained = applySearchReplace("a\nb\nc", [
    { search: "a", replace: "A" },
    { search: "A\nb", replace: "AB" },
  ]);
  assert.deepEqual(chained, { ok: true, content: "AB\nc" });
  assert.equal(parseSearchReplace("no blocks here"), null);
});

test("compactAssistantTurn drops written file bodies and applied edits", () => {
  const compacted = compactAssistantTurn('<friday-write path="a.js">big</friday-write> x <friday-edit path="b.js">\n<<<<<<< SEARCH\nq\n=======\nr\n>>>>>>> REPLACE\n</friday-edit>');
  assert.doesNotMatch(compacted, /big|SEARCH/);
  assert.match(compacted, /already applied/);
});

test("findGitHubRepoUrl extracts owner/repo and branch", () => {
  assert.deepEqual(findGitHubRepoUrl("fix the login bug in https://github.com/acme/web-app please"), { repo: "acme/web-app" });
  assert.deepEqual(findGitHubRepoUrl("work on github.com/acme/api.git"), { repo: "acme/api" });
  assert.deepEqual(findGitHubRepoUrl("see https://github.com/acme/api/tree/dev/src"), { repo: "acme/api", branch: "dev/src" });
  assert.deepEqual(findGitHubRepoUrl("bug: https://github.com/acme/api/issues/12"), { repo: "acme/api" });
  assert.equal(findGitHubRepoUrl("build me a todo app"), null);
  assert.match(branchNameFor("Add Dark Mode!"), /^friday\/add-dark-mode-[a-z0-9]{1,4}$/);
});
