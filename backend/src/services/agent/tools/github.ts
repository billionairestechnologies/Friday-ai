import { getGitHubAccessToken } from "../../connectorService.js";
import { clip, num, str, type FridayTool, type ToolContext } from "./types.js";

const API = "https://api.github.com";
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

async function gh(ctx: ToolContext, path: string): Promise<unknown> {
  const token = await getGitHubAccessToken(ctx.userId);
  if (!token) throw new Error("GitHub is not connected — ask the user to connect it from Plugins.");
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Friday-AI",
    },
    signal: ctx.signal,
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function repoArg(args: Record<string, unknown>): string {
  const repo = str(args, "repo").replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  if (!REPO_RE.test(repo)) throw new Error('repo must look like "owner/name"');
  return repo;
}

function encodePath(path: string): string {
  return path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

export const githubListReposTool: FridayTool = {
  spec: {
    name: "github_list_repos",
    description: "List the user's GitHub repositories (most recently updated first), optionally filtered by a name substring.",
    parameters: { type: "object", properties: { filter: { type: "string", description: "Optional name filter" } } },
  },
  label: () => "Listed GitHub repositories",
  async run(args, ctx) {
    const repos = (await gh(ctx, "/user/repos?sort=updated&per_page=100")) as {
      full_name: string;
      description: string | null;
      private: boolean;
      language: string | null;
      updated_at: string;
    }[];
    const filter = str(args, "filter").toLowerCase();
    const list = repos.filter((r) => !filter || r.full_name.toLowerCase().includes(filter)).slice(0, 40);
    if (list.length === 0) return "No matching repositories.";
    return list
      .map((r) => `${r.full_name}${r.private ? " (private)" : ""} · ${r.language ?? "?"} · updated ${r.updated_at.slice(0, 10)}${r.description ? ` — ${r.description}` : ""}`)
      .join("\n");
  },
};

export const githubReadFileTool: FridayTool = {
  spec: {
    name: "github_read_file",
    description:
      "Read a file from a GitHub repository, or list a directory's entries when the path is a folder (use path \"\" for the repo root).",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: 'Repository as "owner/name"' },
        path: { type: "string", description: "File or directory path inside the repo" },
        ref: { type: "string", description: "Optional branch, tag or commit" },
      },
      required: ["repo", "path"],
    },
  },
  label: (args) => `Read ${str(args, "repo")}/${str(args, "path")}`.replace(/\/$/, ""),
  async run(args, ctx) {
    const repo = repoArg(args);
    const ref = str(args, "ref");
    const data = await gh(ctx, `/repos/${repo}/contents/${encodePath(str(args, "path"))}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
    if (Array.isArray(data)) {
      return (data as { name: string; type: string; size: number }[])
        .map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.name}${e.type === "file" ? ` (${e.size} B)` : ""}`)
        .join("\n");
    }
    const file = data as { content?: string; encoding?: string; size: number; path: string; html_url?: string };
    if (file.html_url) ctx.onCite?.(file.html_url, file.path);
    if (!file.content || file.encoding !== "base64") return `${file.path} is ${file.size} bytes and can't be shown as text.`;
    return clip(Buffer.from(file.content, "base64").toString("utf8"), 30_000);
  },
};

export const githubSearchCodeTool: FridayTool = {
  spec: {
    name: "github_search_code",
    description: "Search code on GitHub (GitHub code search syntax). Pass repo to search inside one repository.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms, e.g. a function name" },
        repo: { type: "string", description: 'Optional "owner/name" to restrict the search' },
      },
      required: ["query"],
    },
  },
  label: (args) => `Searched code · "${str(args, "query").slice(0, 60)}"`,
  async run(args, ctx) {
    const q = [str(args, "query"), args.repo ? `repo:${repoArg(args)}` : ""].filter(Boolean).join(" ");
    const data = (await gh(ctx, `/search/code?per_page=20&q=${encodeURIComponent(q)}`)) as {
      total_count: number;
      items: { path: string; repository: { full_name: string }; html_url: string }[];
    };
    if (!data.items?.length) return "No matches.";
    return `${data.total_count} matches (first ${data.items.length}):\n${data.items.map((i) => `${i.repository.full_name}: ${i.path}`).join("\n")}`;
  },
};

export const githubListIssuesTool: FridayTool = {
  spec: {
    name: "github_list_issues",
    description: "List issues or pull requests of a GitHub repository.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: 'Repository as "owner/name"' },
        kind: { type: "string", enum: ["issues", "pulls"], description: "issues (default) or pulls" },
        state: { type: "string", enum: ["open", "closed", "all"], description: "Default open" },
        limit: { type: "integer", description: "1-50, default 20" },
      },
      required: ["repo"],
    },
  },
  label: (args) => `Listed ${str(args, "kind", "issues") === "pulls" ? "pull requests" : "issues"} · ${str(args, "repo")}`,
  async run(args, ctx) {
    const repo = repoArg(args);
    const kind = str(args, "kind") === "pulls" ? "pulls" : "issues";
    const state = ["open", "closed", "all"].includes(str(args, "state")) ? str(args, "state") : "open";
    const items = (await gh(ctx, `/repos/${repo}/${kind}?state=${state}&per_page=${num(args, "limit", 20, 1, 50)}`)) as {
      number: number;
      title: string;
      state: string;
      user?: { login: string };
      pull_request?: unknown;
      updated_at: string;
    }[];
    const list = kind === "issues" ? items.filter((i) => !i.pull_request) : items;
    if (list.length === 0) return `No ${state} ${kind}.`;
    return list.map((i) => `#${i.number} [${i.state}] ${i.title} — @${i.user?.login ?? "?"} · ${i.updated_at.slice(0, 10)}`).join("\n");
  },
};

export const githubReadIssueTool: FridayTool = {
  spec: {
    name: "github_read_issue",
    description: "Read one GitHub issue or pull request with its description and latest comments.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: 'Repository as "owner/name"' },
        number: { type: "integer", description: "Issue or PR number" },
      },
      required: ["repo", "number"],
    },
  },
  label: (args) => `Read ${str(args, "repo")}#${str(args, "number")}`,
  async run(args, ctx) {
    const repo = repoArg(args);
    const n = num(args, "number", 0, 1, 10_000_000);
    const issue = (await gh(ctx, `/repos/${repo}/issues/${n}`)) as { title: string; body: string | null; state: string; html_url: string; user?: { login: string } };
    const comments = (await gh(ctx, `/repos/${repo}/issues/${n}/comments?per_page=20`)) as { body: string; user?: { login: string } }[];
    ctx.onCite?.(issue.html_url, issue.title);
    return clip(
      `#${n} [${issue.state}] ${issue.title} — @${issue.user?.login ?? "?"}\n\n${issue.body ?? "(no description)"}\n\n` +
        comments.map((c) => `--- @${c.user?.login ?? "?"}:\n${c.body}`).join("\n\n"),
      25_000,
    );
  },
};

export const GITHUB_TOOLS = [githubListReposTool, githubReadFileTool, githubSearchCodeTool, githubListIssuesTool, githubReadIssueTool];
