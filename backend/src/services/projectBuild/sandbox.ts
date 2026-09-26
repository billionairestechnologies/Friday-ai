import { Sandbox } from "@e2b/code-interpreter";
import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../middleware/errorHandler.js";

export const PROJECT_DIR = "/home/user/app";
// E2B kills (never pauses) a sandbox when this expires, so nothing lingers there. Project files live
// in our own database (build_projects.files); a sandbox only exists while a build or preview needs it.
const SANDBOX_TTL_MS = 15 * 60 * 1000;
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
  /** "owner/name" when the project was imported from GitHub. */
  repo?: string | null;
  repo_branch?: string | null;
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
    .select("conversation_id, sandbox_id, start_cmd, port, files, repo, repo_branch")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return (data as ProjectRow | null) ?? null;
}

export async function saveProject(userId: string, conversationId: string, patch: Partial<Omit<ProjectRow, "conversation_id">>) {
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
  /** Mutable so a stale/expired connection can be swapped out transparently — see `withReconnect`. */
  private sandbox: Sandbox;

  private constructor(
    sandbox: Sandbox,
    readonly userId: string,
    readonly conversationId: string,
    /** True when this call created a brand-new sandbox (files restored from snapshot, nothing installed). */
    readonly fresh: boolean,
  ) {
    this.sandbox = sandbox;
  }

  /** Creates a brand-new sandbox and restores the last known file snapshot into it. */
  private static async createFresh(userId: string, conversationId: string, apiKey: string, files: ProjectFiles): Promise<Sandbox> {
    const sandbox = await Sandbox.create({ apiKey, timeoutMs: SANDBOX_TTL_MS });
    await sandbox.commands.run(`mkdir -p ${PROJECT_DIR}`);
    await Promise.all(Object.entries(files).map(([path, content]) => sandbox.files.write(`${PROJECT_DIR}/${path}`, content)));
    await saveProject(userId, conversationId, { sandbox_id: sandbox.sandboxId });
    return sandbox;
  }

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

    const sandbox = await BuildSandbox.createFresh(userId, conversationId, apiKey, project?.files ?? {});
    return new BuildSandbox(sandbox, userId, conversationId, true);
  }

  /**
   * `Sandbox.connect()` at open() can succeed against a sandbox that then turns out to be gone (E2B's
   * TTL firing in the gap, or a connect that doesn't fully validate liveness) — confirmed in production
   * 2026-09-26: a whole Build turn logged 15 straight "The sandbox was not found" write failures with
   * no recovery, because nothing downstream of open() ever re-checked the connection. Every sandbox
   * operation below runs through this: on that specific error it recreates the sandbox from the last
   * saved snapshot ONCE and retries, instead of cascading through the rest of the turn broken.
   */
  private reconnecting: Promise<void> | null = null;
  private async withReconnect<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/sandbox.{0,15}(was )?not found|sandbox.{0,20}(timed? ?out|timeout)/i.test(message)) throw err;
      if (!this.reconnecting) {
        this.reconnecting = (async () => {
          if (!env.e2bApiKey) throw new HttpError(503, "Building isn't configured yet — missing E2B_API_KEY.");
          const project = await getProject(this.conversationId);
          this.sandbox = await BuildSandbox.createFresh(this.userId, this.conversationId, env.e2bApiKey, project?.files ?? {});
        })().finally(() => {
          this.reconnecting = null;
        });
      }
      await this.reconnecting;
      return op();
    }
  }

  /** True if the port answers a plain HTTP probe (200-499 — anything the server itself produced). */
  async isServing(port: number): Promise<boolean> {
    const probe = await this.withReconnect(() =>
      this.sandbox.commands.run(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/ || true`, { timeoutMs: 8000 }),
    ).catch(() => null);
    const code = Number(probe?.stdout.trim() ?? 0);
    return code >= 200 && code < 500;
  }

  /** The public preview URL for a port this sandbox is serving on. */
  previewUrl(port: number): string {
    return `https://${this.sandbox.getHost(port)}`;
  }

  /** Destroys the sandbox for good (kill, not pause) and forgets it — the files stay in our database. */
  async kill(): Promise<void> {
    await this.sandbox.kill().catch(() => {});
    await saveProject(this.userId, this.conversationId, { sandbox_id: null });
  }

  private touch() {
    void this.sandbox.setTimeout(SANDBOX_TTL_MS).catch(() => {});
  }

  async write(path: string, content: string) {
    this.touch();
    await this.withReconnect(() => this.sandbox.files.write(`${PROJECT_DIR}/${path}`, content));
  }

  async read(path: string): Promise<string> {
    return this.withReconnect(() => this.sandbox.files.read(`${PROJECT_DIR}/${path}`));
  }

  /** Runs a command to completion (installs, builds, scripts). Never throws — failures are data. */
  async run(cmd: string, timeoutMs = 5 * 60_000, signal?: AbortSignal): Promise<RunOutcome> {
    this.touch();
    if (signal?.aborted) return { ok: false, exitCode: -1, output: "cancelled" };
    try {
      const result = await this.withReconnect(() =>
        this.sandbox.commands.run(`bash -lc ${JSON.stringify(`cd ${PROJECT_DIR} && ${cmd}`)}`, {
          timeoutMs,
          envs: { CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
        }),
      );
      return { ok: true, exitCode: 0, output: [result.stdout, result.stderr].filter(Boolean).join("\n") };
    } catch (err) {
      const e = err as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n") || e.message || "command failed";
      return { ok: false, exitCode: typeof e.exitCode === "number" ? e.exitCode : 1, output };
    }
  }

  /**
   * Runs a trusted, server-built script from a file (not an inline command string), so environment
   * values such as a PR title or an access token are only ever expanded as variables — never
   * re-parsed as shell code. Used for the git operations that carry the user's GitHub token.
   */
  async runScript(script: string, timeoutMs: number, envs: Record<string, string>): Promise<RunOutcome> {
    this.touch();
    const file = `/tmp/friday-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.sh`;
    try {
      const result = await this.withReconnect(async () => {
        await this.sandbox.files.write(file, `cd ${PROJECT_DIR}\n${script}\n`);
        return this.sandbox.commands.run(`bash ${file}`, { timeoutMs, envs: { CI: "true", ...envs } });
      });
      return { ok: true, exitCode: 0, output: [result.stdout, result.stderr].filter(Boolean).join("\n") };
    } catch (err) {
      const e = err as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n") || e.message || "command failed";
      return { ok: false, exitCode: typeof e.exitCode === "number" ? e.exitCode : 1, output };
    } finally {
      void this.sandbox.commands.run(`rm -f ${file}`).catch(() => {});
    }
  }

  /**
   * Vite rejects Host headers it doesn't know ("Blocked request. This host is not allowed"), and the
   * preview is served from a random *.e2b.app host per sandbox. Env vars alone proved unreliable, so
   * patch the project's vite config to set server/preview.allowedHosts = true before every start.
   */
  private async allowPreviewHosts(): Promise<void> {
    for (const name of ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"]) {
      const path = `${PROJECT_DIR}/${name}`;
      const src = await this.sandbox.files.read(path).catch(() => null);
      if (src == null) continue;
      let out = src;
      for (const key of ["server", "preview"]) {
        if (new RegExp(`\\b${key}\\s*:\\s*\\{[^}]*allowedHosts\\s*:`).test(out)) {
          out = out.replace(new RegExp(`(\\b${key}\\s*:\\s*\\{[^}]*?allowedHosts\\s*:\\s*)(\\[[^\\]]*\\]|[^,}\\n]+)`), "$1true");
        } else if (new RegExp(`\\b${key}\\s*:\\s*\\{`).test(out)) {
          out = out.replace(new RegExp(`(\\b${key}\\s*:\\s*\\{)`), "$1 allowedHosts: true,");
        } else if (/defineConfig\(\s*\{/.test(out)) {
          out = out.replace(/defineConfig\(\s*\{/, `defineConfig({ ${key}: { allowedHosts: true },`);
        } else if (/export\s+default\s*\{/.test(out)) {
          out = out.replace(/export\s+default\s*\{/, `export default { ${key}: { allowedHosts: true },`);
        }
      }
      if (out !== src) await this.sandbox.files.write(path, out);
      return;
    }
  }

  /** Starts a long-running server in the background and waits until it answers on `port`. */
  async start(cmd: string, port: number): Promise<{ ready: boolean; url: string | null; log: string }> {
    this.touch();
    const logFile = `/tmp/friday-server-${port}.log`;
    const pidFile = `/tmp/friday-server-${port}.pid`;
    // Restarting must really replace the old stack (dev commands like `concurrently` spawn several
    // processes). Each start runs in its own process group, so the whole group can be killed cleanly —
    // no fragile `pkill -f` (which matches its own command line) and no orphaned listeners on other ports.
    await this.sandbox.commands
      .run(`test -f ${pidFile} && kill -TERM -$(cat ${pidFile}) 2>/dev/null; sleep 0.5; fuser -k ${port}/tcp >/dev/null 2>&1; true`)
      .catch(() => {});
    await this.allowPreviewHosts().catch(() => {});
    const script = `echo $$ > ${pidFile}; cd ${PROJECT_DIR} && exec bash -lc ${JSON.stringify(cmd)} > ${logFile} 2>&1`;
    await this.sandbox.commands.run(`setsid bash -c ${JSON.stringify(script)}`, {
      background: true,
      // Vite (5.4.12+) rejects unknown Host headers by default; the preview is served from *.e2b.app.
      // No PORT is injected on purpose: it leaked into multi-process stacks (an API that reads PORT
      // grabbed the frontend's port). Ports are set explicitly in the command / config.
      envs: { HOST: "0.0.0.0", BROWSER: "none", __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".e2b.app", FORCE_COLOR: "0" },
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
    if ((path === "/" ? res.status >= 500 : res.status >= 400) || (/javascript|html|css|json/.test(res.headers.get("content-type") || "") && bad.test(body.slice(0, 4000)))) {
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

  /**
   * Opens the running app in a real headless Chromium (Playwright, installed into the sandbox on first
   * use — about 30s once) and returns a full-page screenshot plus any browser console errors. This is
   * what lets Friday actually SEE the result: an HTTP 200 says nothing about a page whose layout CSS
   * never loaded, or a React app that renders blank.
   */
  async screenshot(port: number): Promise<{ png: Uint8Array | null; consoleErrors: string[]; bodyTextLength: number; note?: string }> {
    const ready = await this.run("test -f /tmp/pw/.ready && echo y", 15_000);
    if (!ready.output.includes("y")) {
      const setup = await this.run(
        "mkdir -p /tmp/pw && cd /tmp/pw && (test -f package.json || npm init -y >/dev/null) && npm i playwright-core --no-audit --no-fund 2>&1 | tail -1 && npx playwright-core install chromium 2>&1 | tail -1 && sudo npx playwright-core install-deps chromium >/dev/null 2>&1; touch /tmp/pw/.ready",
        4 * 60_000,
      );
      if (!setup.ok) return { png: null, consoleErrors: [], bodyTextLength: -1, note: `browser setup failed: ${tail(setup.output, 300)}` };
    }
    await this.sandbox.files.write(
      "/tmp/pw/shot.mjs",
      `import { chromium } from "playwright-core";
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 300)); });
page.on("pageerror", (e) => errors.push("uncaught: " + String(e.message).slice(0, 300)));
page.on("requestfailed", (r) => { if (!/fonts\\.g|google/.test(r.url())) errors.push("request failed: " + r.url().slice(0, 150)); });
try { await page.goto("http://localhost:${port}/", { waitUntil: "networkidle", timeout: 25000 }); } catch (e) { errors.push("navigation: " + e.message.slice(0, 200)); }
await page.waitForTimeout(1200);
const len = await page.evaluate(() => (document.body ? document.body.innerText.length : 0));
const height = await page.evaluate(() => document.documentElement.scrollHeight);
await page.screenshot({ path: "/tmp/pw/shot.png", fullPage: true, clip: { x: 0, y: 0, width: 1280, height: Math.min(height, 2800) } });
await browser.close();
console.log(JSON.stringify({ errors: errors.slice(0, 8), len }));`,
    );
    const out = await this.run("cd /tmp/pw && node shot.mjs", 90_000);
    if (!out.ok) return { png: null, consoleErrors: [], bodyTextLength: -1, note: `screenshot failed: ${tail(out.output, 300)}` };
    let meta = { errors: [] as string[], len: 0 };
    try {
      meta = JSON.parse(out.output.trim().split("\n").pop() ?? "{}");
    } catch {
      /* keep defaults */
    }
    const png = await this.sandbox.files.read("/tmp/pw/shot.png", { format: "bytes" }).catch(() => null);
    return { png, consoleErrors: meta.errors ?? [], bodyTextLength: meta.len ?? 0 };
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
    return { url: null, port: null, message: "Nothing has been built here yet — send “build it” in the chat to start." };
  }
  const box = await BuildSandbox.open(userId, conversationId);
  const { port, start_cmd: startCmd } = project;

  if (!box.fresh && (await box.isServing(port))) {
    return { url: box.previewUrl(port), port };
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
