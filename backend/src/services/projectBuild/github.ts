import { getGitHubAccessToken } from "../connectorService.js";
import { type BuildSandbox, PROJECT_DIR, tail } from "./sandbox.js";

/**
 * Build Mode on existing GitHub code: clone a repo into the project sandbox, and open a pull request
 * with the agent's changes. The user's token is only ever handed to the git commands built here (as
 * an env var turned into a one-off auth header) — never to model-written commands, never written into
 * .git/config — and is redacted from any output shown to the model or the user.
 */

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const REF_RE = /^[\w][\w./-]{0,120}$/;
const AUTH = `-c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"`;

export type RepoRef = { repo: string; branch?: string };

/** Finds a github.com repository link in a message ("…github.com/owner/repo/tree/dev…"). */
export function findGitHubRepoUrl(text: string): RepoRef | null {
  const m = text.match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w./-]+?))?(?=[\s)>\]"'`,]|\/?$|\/(?:blob|issues|pulls)\b|$)/i);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  if (!REPO_RE.test(repo)) return null;
  const branch = m[3]?.replace(/\/$/, "");
  return branch && REF_RE.test(branch) ? { repo, branch } : { repo };
}

function redact(text: string, token: string | null): string {
  return token ? text.split(token).join("***") : text;
}

export function branchNameFor(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "changes";
  return `friday/${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Clones `repo` into the (empty) project directory. Works for public repos without a connector. */
export async function importRepo(
  box: BuildSandbox,
  userId: string,
  ref: RepoRef,
): Promise<{ ok: boolean; branch: string | null; message: string }> {
  if (!REPO_RE.test(ref.repo) || (ref.branch && !REF_RE.test(ref.branch))) return { ok: false, branch: null, message: "Invalid repository reference" };
  const token = await getGitHubAccessToken(userId).catch(() => null);
  const auth = token ? AUTH : "";
  // A /tree/<a>/<b> link is ambiguous (branch "a/b", or branch "a" + folder "b"): try the longest first.
  const branches: (string | undefined)[] = ref.branch
    ? [...new Set([ref.branch, ref.branch.split("/")[0]!])]
    : [undefined];
  let out = { ok: false, exitCode: 1, output: "" };
  for (const branch of branches) {
    out = await box.runScript(
      `git ${auth} clone --depth 1 ${branch ? `--branch ${branch} ` : ""}https://github.com/${ref.repo}.git . 2>&1 && git rev-parse --abbrev-ref HEAD`,
      3 * 60_000,
      token ? { GH_TOKEN: token } : {},
    );
    if (out.ok) break;
  }
  const output = redact(out.output, token);
  if (!out.ok) {
    const hint = token ? "" : " If it is private, connect GitHub from Plugins first.";
    return { ok: false, branch: null, message: `Couldn't clone ${ref.repo}.${hint}\n${tail(output, 800)}` };
  }
  const branch = output.trim().split("\n").pop()?.trim() || ref.branch || null;
  return { ok: true, branch, message: `Cloned ${ref.repo}${branch ? ` (${branch})` : ""}` };
}

/**
 * Commits the project on a new branch (on top of a fresh clone of the base branch, so it works even
 * after the sandbox was restored from a snapshot), pushes it, and opens a pull request.
 */
export async function openPullRequest(
  box: BuildSandbox,
  userId: string,
  opts: { repo: string; base: string; title: string; branch?: string; body: string },
): Promise<{ ok: boolean; url?: string; message: string }> {
  const token = await getGitHubAccessToken(userId).catch(() => null);
  if (!token) return { ok: false, message: "GitHub isn't connected — ask the user to connect GitHub from Plugins, then try again." };
  if (!REPO_RE.test(opts.repo) || !REF_RE.test(opts.base)) return { ok: false, message: "Invalid repository or base branch" };
  const branch = opts.branch && REF_RE.test(opts.branch) && opts.branch !== opts.base ? opts.branch : branchNameFor(opts.title);
  const work = "/tmp/friday-pr";
  const script = [
    "set -e",
    `rm -rf ${work}`,
    `git ${AUTH} clone -q --depth 1 --branch ${opts.base} https://github.com/${opts.repo}.git ${work}`,
    `cd ${work} && git checkout -q -b ${branch}`,
    // Overlay the project onto the clone (no deletions — binary files are never in the snapshot).
    `(cd ${PROJECT_DIR} && tar --exclude=./node_modules --exclude=./.git --exclude=./dist --exclude=./.next -cf - .) | tar -xf -`,
    "git add -A",
    'if git diff --cached --quiet; then echo FRIDAY_NO_CHANGES; exit 0; fi',
    'git -c user.name="Friday AI" -c user.email="friday-ai@users.noreply.github.com" commit -q -m "$PR_TITLE"',
    `git ${AUTH} push -q origin ${branch}`,
    "git diff --stat HEAD~1 | tail -1",
  ].join("\n");
  const out = await box.runScript(script, 4 * 60_000, { GH_TOKEN: token, PR_TITLE: opts.title.slice(0, 200) });
  const output = redact(out.output, token);
  if (!out.ok) return { ok: false, message: `Couldn't push the branch:\n${tail(output, 1200)}` };
  if (output.includes("FRIDAY_NO_CHANGES")) return { ok: false, message: "There are no changes compared to the base branch, so there is nothing to open a PR for." };

  const res = await fetch(`https://api.github.com/repos/${opts.repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Friday-AI",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: opts.title.slice(0, 200),
      head: branch,
      base: opts.base,
      body: `${opts.body || opts.title}\n\n---\n_Opened by Friday AI Build Mode._`,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { html_url?: string; message?: string };
  if (!res.ok || !body.html_url) {
    return { ok: false, message: `Pushed branch ${branch}, but opening the PR failed: ${body.message ?? res.status}` };
  }
  return { ok: true, url: body.html_url, message: `Opened ${body.html_url} (branch ${branch} → ${opts.base}). ${output.trim().split("\n").pop() ?? ""}` };
}
