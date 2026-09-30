import { HttpError } from "../middleware/errorHandler.js";
import { disconnectConnector, getGitHubAccessToken } from "./connectorService.js";

/**
 * GitHub for the Build composer's repo / branch picker (like Claude Code's repo + branch chips): the
 * user's own repositories (private included), a repo's branches, and creating a new repository or
 * branch — all with the user's connected GitHub account (Plugins → GitHub, scope "repo").
 */
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const BRANCH_RE = /^(?!\/|.*(?:\/\/|\.\.|@\{|\\))[\w./-]{1,200}(?<![./])$/;

async function gh<T>(userId: string, path: string, init: RequestInit = {}): Promise<T> {
  const token = await getGitHubAccessToken(userId);
  if (!token) throw new HttpError(400, "Connect GitHub first (Plugins → GitHub).");
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Friday-AI",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; errors?: { message?: string }[] };
  if (!res.ok) {
    if (res.status === 401) {
      await disconnectConnector(userId, "github").catch(() => {});
      throw new HttpError(401, "GitHub's connection has expired or was revoked — reconnect it from Plugins.");
    }
    const detail = body.errors?.map((e) => e.message).filter(Boolean).join("; ");
    throw new HttpError(res.status === 404 ? 404 : res.status === 422 ? 400 : 502, detail || body.message || "GitHub request failed");
  }
  return body;
}

export type RepoSummary = { fullName: string; private: boolean; defaultBranch: string; description: string | null; updatedAt: string };

/** The user's repositories (owner, collaborator, org member), most recently pushed first, filtered by name. */
export async function listMyRepos(userId: string, query: string): Promise<RepoSummary[]> {
  const repos = await gh<Array<{ full_name: string; private: boolean; default_branch: string; description: string | null; pushed_at: string }>>(
    userId,
    "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
  );
  const q = query.trim().toLowerCase();
  return repos
    .filter((r) => !q || r.full_name.toLowerCase().includes(q))
    .slice(0, 30)
    .map((r) => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, description: r.description, updatedAt: r.pushed_at }));
}

export async function listBranches(userId: string, repo: string): Promise<{ branches: string[]; defaultBranch: string }> {
  if (!REPO_RE.test(repo)) throw new HttpError(400, "Invalid repository");
  const [info, branches] = await Promise.all([
    gh<{ default_branch: string }>(userId, `/repos/${repo}`),
    gh<Array<{ name: string }>>(userId, `/repos/${repo}/branches?per_page=100`),
  ]);
  const names = branches.map((b) => b.name);
  // Default branch first, then the rest alphabetically.
  names.sort((a, b) => (a === info.default_branch ? -1 : b === info.default_branch ? 1 : a.localeCompare(b)));
  return { branches: names, defaultBranch: info.default_branch };
}

/** Creates a repository on the user's account (initialised with a README so it has a branch to clone). */
export async function createRepo(userId: string, opts: { name: string; private: boolean; description?: string }): Promise<RepoSummary> {
  if (!/^[\w.-]{1,100}$/.test(opts.name)) throw new HttpError(400, "Use letters, digits, - _ . for the repository name.");
  const r = await gh<{ full_name: string; private: boolean; default_branch: string; description: string | null; pushed_at: string }>(userId, "/user/repos", {
    method: "POST",
    body: JSON.stringify({ name: opts.name, private: opts.private, description: opts.description ?? "", auto_init: true }),
  });
  return { fullName: r.full_name, private: r.private, defaultBranch: r.default_branch || "main", description: r.description, updatedAt: r.pushed_at };
}

/** Creates `branch` from the tip of `from` on GitHub, so the build can clone and work on it. */
export async function createBranch(userId: string, repo: string, branch: string, from: string): Promise<void> {
  if (!REPO_RE.test(repo)) throw new HttpError(400, "Invalid repository");
  if (!BRANCH_RE.test(branch) || !BRANCH_RE.test(from)) throw new HttpError(400, "Invalid branch name");
  const base = await gh<{ object: { sha: string } }>(userId, `/repos/${repo}/git/ref/heads/${from.split("/").map(encodeURIComponent).join("/")}`);
  await gh(userId, `/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }) });
}
