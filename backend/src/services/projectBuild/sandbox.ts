import { Sandbox } from "@e2b/code-interpreter";
import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../middleware/errorHandler.js";

export const PROJECT_DIR = "/home/user/app";
const SANDBOX_TTL_MS = 30 * 60 * 1000;
const SNAPSHOT_MAX_FILES = 300;
const SNAPSHOT_MAX_FILE_BYTES = 200_000;
const SNAPSHOT_MAX_TOTAL_BYTES = 3_000_000;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|mp[34]|zip|gz|pdf|lock|map)$/i;

export type ProjectFiles = Record<string, string>;

export type ProjectRow = {
  conversation_id: string;
  sandbox_id: string | null;
  start_cmd: string | null;
  port: number | null;
  files: ProjectFiles;
};

export type RunOutcome = { ok: boolean; exitCode: number; output: string };

/** Keep the END of long output — that's where the actual error is. */
export function tail(text: string, max = 4000): string {
  return text.length <= max ? text : `…(truncated)…\n${text.slice(text.length - max)}`;
}

/** Rejects paths that would escape the project directory. */
export function safeProjectPath(path: string): string | null {
  const cleaned = path.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!cleaned || cleaned.startsWith("/") || cleaned.split("/").includes("..")) return null;
  return cleaned;
}

export async function getProject(conversationId: string): Promise<ProjectRow | null> {
  const { data } = await supabaseAdmin
    .from("build_projects")
    .select("conversation_id, sandbox_id, start_cmd, port, files")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return (data as ProjectRow | null) ?? null;
}

async function saveProject(userId: string, conversationId: string, patch: Partial<Omit<ProjectRow, "conversation_id">>) {
  const { error } = await supabaseAdmin
    .from("build_projects")
    .upsert({ conversation_id: conversationId, user_id: userId, ...patch, updated_at: new Date().toISOString() });
  if (error) console.error("[build] failed to save project:", error.message);
}

/**
 * One sandbox per conversation. Reconnects to the recorded one; if it has expired, creates a fresh
 * sandbox and restores the last file snapshot into it (dependencies get reinstalled by the caller).
 */
export class BuildSandbox {
  private constructor(
    readonly sandbox: Sandbox,
    readonly userId: string,
    readonly conversationId: string,
    /** True when this call created a brand-new sandbox (files restored from snapshot, nothing installed). */
    readonly fresh: boolean,
  ) {}

  static async open(userId: string, conversationId: string): Promise<BuildSandbox> {
    if (!env.e2bApiKey) throw new HttpError(503, "Building isn't configured yet — missing E2B_API_KEY.");
    const apiKey = env.e2bApiKey;
    const project = await getProject(conversationId);

    if (project?.sandbox_id) {
      try {
        const sandbox = await Sandbox.connect(project.sandbox_id, { apiKey });
        await sandbox.setTimeout(SANDBOX_TTL_MS).catch(() => {});
        return new BuildSandbox(sandbox, userId, conversationId, false);
      } catch {
        /* expired / unreachable — fall through to a fresh one */
      }
    }

    const sandbox = await Sandbox.create({ apiKey, timeoutMs: SANDBOX_TTL_MS });
    await sandbox.commands.run(`mkdir -p ${PROJECT_DIR}`);
    const files = project?.files ?? {};
    await Promise.all(Object.entries(files).map(([path, content]) => sandbox.files.write(`${PROJECT_DIR}/${path}`, content)));
    await saveProject(userId, conversationId, { sandbox_id: sandbox.sandboxId });
    return new BuildSandbox(sandbox, userId, conversationId, true);
  }

  private touch() {
    void this.sandbox.setTimeout(SANDBOX_TTL_MS).catch(() => {});
  }

  async write(path: string, content: string) {
    this.touch();
    await this.sandbox.files.write(`${PROJECT_DIR}/${path}`, content);
  }

  async read(path: string): Promise<string> {
    return this.sandbox.files.read(`${PROJECT_DIR}/${path}`);
  }

  /** Runs a command to completion (installs, builds, scripts). Never throws — failures are data. */
  async run(cmd: string, timeoutMs = 5 * 60_000, signal?: AbortSignal): Promise<RunOutcome> {
    this.touch();
    if (signal?.aborted) return { ok: false, exitCode: -1, output: "cancelled" };
    try {
      const result = await this.sandbox.commands.run(`bash -lc ${JSON.stringify(`cd ${PROJECT_DIR} && ${cmd}`)}`, {
        timeoutMs,
        envs: { CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
      });
      return { ok: true, exitCode: 0, output: [result.stdout, result.stderr].filter(Boolean).join("\n") };
    } catch (err) {
      const e = err as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n") || e.message || "command failed";
      return { ok: false, exitCode: typeof e.exitCode === "number" ? e.exitCode : 1, output };
    }
  }

  /** Starts a long-running server in the background and waits until it answers on `port`. */
  async start(cmd: string, port: number): Promise<{ ready: boolean; url: string | null; log: string }> {
    this.touch();
    const logFile = `/tmp/friday-server-${port}.log`;
    await this.sandbox.commands.run(`fuser -k ${port}/tcp >/dev/null 2>&1 || true`).catch(() => {});
    const script = `cd ${PROJECT_DIR} && (${cmd}) > ${logFile} 2>&1`;
    await this.sandbox.commands.run(`bash -lc ${JSON.stringify(script)}`, {
      background: true,
      // Vite (5.4.12+) rejects unknown Host headers by default; the preview is served from *.e2b.app.
      envs: { HOST: "0.0.0.0", PORT: String(port), BROWSER: "none", __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".e2b.app", FORCE_COLOR: "0" },
    });

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const probe = await this.sandbox.commands
        .run(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/ || true`, { timeoutMs: 8000 })
        .catch(() => null);
      const code = Number(probe?.stdout.trim() ?? 0);
      if (code >= 200 && code < 500) {
        return { ready: true, url: `https://${this.sandbox.getHost(port)}`, log: await this.logTail(logFile) };
      }
    }
    return { ready: false, url: null, log: await this.logTail(logFile) };
  }

  /**
   * Crawls the running app from inside the sandbox — the page, then every script/stylesheet/module
   * it pulls in — and reports anything that errors. "The server answered on the port" isn't proof
   * the app works: a Vite dev server happily serves index.html while a broken PostCSS/JSX file only
   * fails when that file is first requested (that is exactly how a Tailwind-v4-as-PostCSS-plugin
   * error slipped through as "launched"). Returns "" when everything loaded cleanly.
   */
  async probeApp(port: number): Promise<string> {
    const script = `
const base = "http://localhost:${port}";
const seen = new Set(); const queue = ["/"]; const problems = [];
const bad = /vite-error-overlay|\\[plugin:|Internal server error|SyntaxError|Failed to resolve import|Cannot find module|ReferenceError/i;
(async () => {
  while (queue.length && seen.size < 80) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    let res, body = "";
    try { res = await fetch(base + path, { signal: AbortSignal.timeout(20000) }); body = await res.text(); }
    catch (e) { problems.push(path + " -> request failed: " + e.message); continue; }
    if (res.status >= 400 || (/javascript|html|css|json/.test(res.headers.get("content-type") || "") && bad.test(body.slice(0, 4000)))) {
      const errMsg = body.match(/"message":"(.*?)","/);
      problems.push(path + " -> HTTP " + res.status + ": " + (errMsg ? errMsg[1] : body.slice(0, 700)));
      continue;
    }
    const found = [...body.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(m => m[1])
      .concat([...body.matchAll(/(?:from|import)\\s*\\(?\\s*["']([^"']+)["']/g)].map(m => m[1]));
    for (let ref of found) {
      if (ref.startsWith("./")) ref = ref.slice(1);
      if (!ref.startsWith("/") || ref.startsWith("//") || ref.startsWith("/@") || ref.includes("/node_modules/") || /\\.(png|jpe?g|gif|svg|ico|webp|woff2?)($|\\?)/.test(ref)) continue;
      queue.push(ref);
    }
  }
  console.log(problems.length ? problems.slice(0, 3).join("\\n---\\n") : "");
})();`;
    await this.sandbox.files.write("/tmp/friday-probe.mjs", script);
    const out = await this.sandbox.commands
      .run("node /tmp/friday-probe.mjs", { timeoutMs: 120_000 })
      .catch((e: { stdout?: string; stderr?: string; message?: string }) => ({
        stdout: `${e.stdout ?? ""}${e.stderr ? `\n${e.stderr}` : ""}`.trim() || e.message || "probe failed",
      }));
    return out.stdout.trim();
  }

  private async logTail(file: string): Promise<string> {
    const out = await this.sandbox.commands.run(`tail -c 3000 ${file} 2>/dev/null || true`).catch(() => null);
    return out?.stdout ?? "";
  }

  /** Persists a text snapshot of the project (no node_modules/build output) + run settings. */
  async snapshot(startCmd?: string, port?: number): Promise<ProjectFiles> {
    const listing = await this.run(
      `find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/.next/*" -not -path "*/__pycache__/*" -not -path "*/.venv/*" -size -${SNAPSHOT_MAX_FILE_BYTES}c | head -${SNAPSHOT_MAX_FILES}`,
      30_000,
    );
    const paths = listing.output
      .split("\n")
      .map((p) => p.trim().replace(/^\.\//, ""))
      .filter((p) => p && !BINARY_EXT.test(p));
    const files: ProjectFiles = {};
    let total = 0;
    for (const path of paths) {
      if (total > SNAPSHOT_MAX_TOTAL_BYTES) break;
      try {
        const content = await this.read(path);
        total += content.length;
        files[path] = content;
      } catch {
        /* unreadable — skip */
      }
    }
    await saveProject(this.userId, this.conversationId, {
      sandbox_id: this.sandbox.sandboxId,
      files,
      ...(startCmd ? { start_cmd: startCmd } : {}),
      ...(port ? { port } : {}),
    });
    return files;
  }
}

/**
 * Makes sure the project's preview is live and returns its URL: reconnects to the sandbox, and if
 * it expired (or the server died) restores the snapshot, reinstalls dependencies and restarts the
 * saved start command. Used when someone opens an old build — from the chat, or another device.
 */
export async function ensurePreview(userId: string, conversationId: string): Promise<{ url: string | null; port: number | null; message?: string }> {
  const project = await getProject(conversationId);
  if (!project || !project.start_cmd || !project.port) {
    return { url: null, port: null, message: "This project has no runnable server yet." };
  }
  const box = await BuildSandbox.open(userId, conversationId);
  const { port, start_cmd: startCmd } = project;

  if (!box.fresh) {
    const probe = await box.sandbox.commands
      .run(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/ || true`, { timeoutMs: 8000 })
      .catch(() => null);
    const code = Number(probe?.stdout.trim() ?? 0);
    if (code >= 200 && code < 500) return { url: `https://${box.sandbox.getHost(port)}`, port };
  }

  if (project.files["package.json"] || (await box.run("test -f package.json && echo y").then((r) => r.output.includes("y")))) {
    const install = await box.run("npm install --no-audit --no-fund", 5 * 60_000);
    if (!install.ok) return { url: null, port, message: `Couldn't reinstall dependencies:\n${tail(install.output, 1500)}` };
  } else if (project.files["requirements.txt"]) {
    await box.run("pip install -r requirements.txt", 5 * 60_000);
  }
  const started = await box.start(startCmd, port);
  return started.ready && started.url
    ? { url: started.url, port }
    : { url: null, port, message: `The server didn't start:\n${tail(started.log, 1500)}` };
}
