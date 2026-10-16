import { Sandbox } from "@e2b/code-interpreter";
import { supabaseAdmin } from "../../config/supabase.js";
import { loadSecrets } from "./secrets.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { chargeAwake } from "../air/awake.js";

export const PROJECT_DIR = "/home/user/app";

async function conversationIsAir(conversationId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("conversations").select("origin").eq("id", conversationId).maybeSingle();
  if (error || !data) return false;
  return (data as { origin?: string }).origin === "air";
}
const SANDBOX_TTL_MS = 15 * 60 * 1000;
/** Air Dots machines pause after 8 idle minutes so a loop cannot hold a computer open. */
const AIR_SANDBOX_TTL_MS = 8 * 60 * 1000;
/**
 * Persistent sandboxes (default on): when the TTL runs out — or a build ends with nothing to preview —
 * the sandbox is PAUSED, not killed. The next message resumes it exactly as it was: node_modules
 * installed, the project's git history, caches, even running processes (memory snapshot). Before,
 * every follow-up after 15 idle minutes started from a bare snapshot of ≤300 text files and had to
 * reinstall everything, and there was no history of what earlier turns changed.
 * The database snapshot (build_projects.files) stays the safety net if a paused sandbox is gone.
 * FRIDAY_SANDBOX_PERSIST=off restores kill-on-timeout.
 */
export const SANDBOX_PERSIST = process.env.FRIDAY_SANDBOX_PERSIST !== "off";
/** Kept out of git without touching the project's own .gitignore. */
const GIT_EXCLUDES = ["node_modules/", "dist/", "build/", ".next/", "__pycache__/", ".venv/", "venv/", "*.log", ".env", ".env.*", ".DS_Store"];
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

/** Looking at the screen keeps an existing Air Dots machine awake. It does not start a new one. */
export async function touchSandbox(conversationId: string, userId?: string): Promise<{ awake: boolean }> {
  const project = await getProject(conversationId);
  if (!project?.sandbox_id || !env.e2bApiKey) return { awake: false };
  try {
    const sandbox = await Sandbox.connect(project.sandbox_id, { apiKey: env.e2bApiKey });
    const air = await conversationIsAir(conversationId);
    if (air && userId) await chargeAwake(userId, `build:${conversationId}`, AIR_SANDBOX_TTL_MS);
    await sandbox.setTimeout(air ? AIR_SANDBOX_TTL_MS : SANDBOX_TTL_MS);
    return { awake: true };
  } catch {
    return { awake: false };
  }
}

export async function writeSandboxFile(userId: string, conversationId: string, path: string, content: string) {
  const sandbox = await BuildSandbox.open(userId, conversationId);
  await sandbox.write(path.replace(/^\/+/, ""), content);
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
/** Vite (5.4.12+) rejects Host headers it doesn't know; the preview is served from a random *.e2b.app host. */
const VITE_HOSTS_ENV = { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".e2b.app" };
const STARTS_DEV_SERVER = /\bvite\b|npm\s+(run\s+)?(dev|start|preview)\b|yarn\s+(dev|start)\b|pnpm\s+(run\s+)?(dev|start)\b/;

export class BuildSandbox {
  /** Mutable so a stale/expired connection can be swapped out transparently — see `withReconnect`. */
  private sandbox: Sandbox;
  /** The project's secrets (secrets.ts), exposed to its commands and dev server as env vars. */
  private projectEnv: Record<string, string> = {};

  useEnv(env: Record<string, string>) {
    this.projectEnv = env;
  }

  private constructor(
    sandbox: Sandbox,
    readonly userId: string,
    readonly conversationId: string,
    /** True when this call created a brand-new sandbox (files restored from snapshot, nothing installed). */
    readonly fresh: boolean,
    private readonly timeoutMs = SANDBOX_TTL_MS,
  ) {
    this.sandbox = sandbox;
  }

  /** Creates a brand-new sandbox and restores the last known file snapshot into it. */
  private static async createFresh(userId: string, conversationId: string, apiKey: string, files: ProjectFiles, timeoutMs: number): Promise<Sandbox> {
    let sandbox: Sandbox;
    if (SANDBOX_PERSIST) {
      try {
        // autoResume: opening the preview URL of a paused sandbox wakes it up.
        sandbox = await Sandbox.create({ apiKey, timeoutMs, lifecycle: { onTimeout: "pause", autoResume: true } });
      } catch (err) {
        // An account/region without pause support must still get a sandbox.
        console.error("[build] pausable sandbox unavailable, using kill-on-timeout:", err instanceof Error ? err.message : err);
        sandbox = await Sandbox.create({ apiKey, timeoutMs });
      }
    } else {
      sandbox = await Sandbox.create({ apiKey, timeoutMs });
    }
    await sandbox.commands.run(`mkdir -p ${PROJECT_DIR}`);
    await Promise.all(Object.entries(files).map(([path, content]) => sandbox.files.write(`${PROJECT_DIR}/${path}`, content)));
    await saveProject(userId, conversationId, { sandbox_id: sandbox.sandboxId });
    return sandbox;
  }

  static async open(userId: string, conversationId: string): Promise<BuildSandbox> {
    if (!env.e2bApiKey) throw new HttpError(503, "Building isn't configured yet — missing E2B_API_KEY.");
    const apiKey = env.e2bApiKey;
    const project = await getProject(conversationId);
    const air = await conversationIsAir(conversationId);
    const timeoutMs = air ? AIR_SANDBOX_TTL_MS : SANDBOX_TTL_MS;

    if (project?.sandbox_id) {
      try {
        const sandbox = await Sandbox.connect(project.sandbox_id, { apiKey });
        // Every keep-alive of an Air Dots machine is charged against today's awake minutes.
        if (air) await chargeAwake(userId, `build:${conversationId}`, timeoutMs);
        await sandbox.setTimeout(timeoutMs).catch(() => {});
        return new BuildSandbox(sandbox, userId, conversationId, false, timeoutMs);
      } catch {
        /* expired / unreachable — fall through to a fresh one */
      }
    }

    if (air) await chargeAwake(userId, `build:${conversationId}`, timeoutMs);
    const sandbox = await BuildSandbox.createFresh(userId, conversationId, apiKey, project?.files ?? {}, timeoutMs);
    return new BuildSandbox(sandbox, userId, conversationId, true, timeoutMs);
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
          this.sandbox = await BuildSandbox.createFresh(this.userId, this.conversationId, env.e2bApiKey, project?.files ?? {}, this.timeoutMs);
        })().finally(() => {
          this.reconnecting = null;
        });
      }
      await this.reconnecting;
      return op();
    }
  }

  /**
   * True when the dev server answers localhost but refuses the sandbox's PUBLIC hostname — Vite's
   * "Blocked request. This host is not allowed" page. A plain localhost probe (isServing / probeApp)
   * can't see it, which is how a "verified" app still showed an error in the preview pane.
   */
  async hostBlocked(port: number): Promise<boolean> {
    const host = this.sandbox.getHost(port);
    const probe = await this.withReconnect(() =>
      this.sandbox.commands.run(`curl -s -m 8 -H "Host: ${host}" http://localhost:${port}/ | head -c 600 || true`, { timeoutMs: 12000 }),
    ).catch(() => null);
    return /Blocked request|host .{0,60}is not allowed/i.test(probe?.stdout ?? "");
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
    return `https://${this.sandbox.getHost(this.publicPort(port))}`;
  }

  /** Destroys the sandbox for good (kill, not pause) and forgets it — the files stay in our database. */
  async kill(): Promise<void> {
    await this.sandbox.kill().catch(() => {});
    await saveProject(this.userId, this.conversationId, { sandbox_id: null });
  }

  /**
   * End of a build with nothing left to serve: pause (persistent mode — the next turn resumes with
   * dependencies and git history intact) or kill. A failed pause falls back to kill so nothing runs on.
   */
  async release(): Promise<void> {
    if (SANDBOX_PERSIST) {
      const paused = await this.sandbox.pause().then(() => true).catch(() => false);
      if (paused) return;
    }
    await this.kill();
  }

  /**
   * The project's own local git history — one commit per Build turn — so the agent (and the user)
   * can see what earlier turns changed, diff against them and roll back. Imported GitHub repos keep
   * their real history underneath. Never throws.
   */
  async gitInit(): Promise<void> {
    await this.runScript(
      [
        "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || git init -q -b main 2>/dev/null || git init -q",
        // set -f: the patterns (*.log, .env.*) must reach the file literally, not glob-expand here.
        'set -f; mkdir -p .git/info && printf "%s\\n" $FRIDAY_EXCLUDES >> .git/info/exclude && sort -u -o .git/info/exclude .git/info/exclude',
        'git config user.name >/dev/null || git config user.name "Friday Build"',
        'git config user.email >/dev/null || git config user.email "build@friday.local"',
      ].join("\n"),
      30_000,
      { FRIDAY_EXCLUDES: GIT_EXCLUDES.join(" ") },
    ).catch(() => null);
  }

  /** Commits everything changed this turn; returns the short hash, or null when nothing changed. */
  async gitCommit(message: string): Promise<string | null> {
    await this.gitInit();
    const out = await this.runScript(
      'git add -A >/dev/null 2>&1; if git diff --cached --quiet; then echo "__nothing__"; else git commit -q -m "$FRIDAY_MSG" && git rev-parse --short HEAD; fi',
      60_000,
      { FRIDAY_MSG: message.replace(/\s+/g, " ").trim().slice(0, 200) || "Friday Build changes" },
    ).catch(() => null);
    const last = out?.output.trim().split("\n").pop() ?? "";
    return out?.ok && /^[0-9a-f]{6,12}$/.test(last) ? last : null;
  }

  /** The last few commits, for the agent's context ("what did earlier turns do?"). */
  async gitLog(limit = 12): Promise<string> {
    const out = await this.runScript(`git log --oneline -n ${Math.max(1, Math.min(50, limit))} 2>/dev/null`, 20_000, {}).catch(() => null);
    return out?.ok ? out.output.trim() : "";
  }

  private touch() {
    // Air Dots machines: each keep-alive is charged against today's awake minutes; once they're gone
    // the machine is left to pause on its idle timer (the work is kept) instead of being extended.
    if (this.timeoutMs === AIR_SANDBOX_TTL_MS) {
      void chargeAwake(this.userId, `build:${this.conversationId}`, this.timeoutMs)
        .then(() => this.sandbox.setTimeout(this.timeoutMs))
        .catch(() => {});
      return;
    }
    void this.sandbox.setTimeout(this.timeoutMs).catch(() => {});
  }

  async write(path: string, content: string) {
    this.touch();
    await this.withReconnect(() => this.sandbox.files.write(`${PROJECT_DIR}/${path}`, content));
    // The agent's own file content never reflects the allowedHosts patch below (it's injected
    // server-side, invisible to the model). An unrelated edit to the SAME vite config file — made
    // from the model's stale, unpatched copy — silently wipes that patch back out, so the dev
    // server starts refusing the public *.e2b.app host again on its next self-restart even though
    // nothing about "running the server" happened this turn. Re-apply immediately after every write.
    if (/^vite\.config\.(ts|js|mjs|mts)$/.test(path)) await this.allowPreviewHosts().catch(() => {});
  }

  async read(path: string): Promise<string> {
    return this.withReconnect(() => this.sandbox.files.read(`${PROJECT_DIR}/${path}`));
  }

  /**
   * Runs a command to completion (installs, builds, scripts). Never throws — failures are data.
   * `onOutput` receives stdout/stderr as it is produced, so the UI can show a live terminal instead
   * of a spinner that sits silent for the whole of a 2-minute `npm install`.
   */
  async run(cmd: string, timeoutMs = 5 * 60_000, signal?: AbortSignal, onOutput?: (chunk: string) => void): Promise<RunOutcome> {
    this.touch();
    if (signal?.aborted) return { ok: false, exitCode: -1, output: "cancelled" };
    // The agent often starts the dev server itself (`npm run dev &`, `npx vite`) instead of start_server —
    // that process must also accept the sandbox's public *.e2b.app host or the preview shows "Blocked request".
    if (STARTS_DEV_SERVER.test(cmd)) await this.allowPreviewHosts().catch(() => {});
    try {
      const result = await this.withReconnect(() =>
        this.sandbox.commands.run(`bash -lc ${JSON.stringify(`cd ${PROJECT_DIR} && ${cmd}`)}`, {
          timeoutMs,
          envs: { ...this.projectEnv, ...VITE_HOSTS_ENV, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
          ...(onOutput ? { onStdout: (d: string) => onOutput(d), onStderr: (d: string) => onOutput(d) } : {}),
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
        } else if (/defineConfig\(\s*(?:\([^)]*\)|\w+)\s*=>\s*\(\s*\{/.test(out)) {
          out = out.replace(/(defineConfig\(\s*(?:\([^)]*\)|\w+)\s*=>\s*\(\s*\{)/, `$1 ${key}: { allowedHosts: true },`);
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

  /**
   * The port the SANDBOX's public hostname actually points at for a given dev-server port — a tiny
   * host-rewriting proxy (`ensureHostProxy`), never the dev server itself. This is the permanent fix
   * for Vite/webpack-dev-server/etc "Blocked request" pages: instead of depending on the project's own
   * config (which a model edit can silently wipe — see `write()`) or on each framework's own
   * allowlist feature (which not all of them even have), nothing public-facing ever reaches the dev
   * server with any Host header other than `localhost:<port>`, the one every dev server always trusts.
   */
  publicPort(port: number): number {
    return port + 20000;
  }

  /**
   * (Re)starts the host-rewriting proxy for `port`: listens on `publicPort(port)`, forwards every
   * request (and WebSocket upgrade, for HMR) to `127.0.0.1:<port>` with the Host header rewritten to
   * `localhost:<port>`. Pure Node core modules — no package to install, nothing that can go missing.
   */
  async ensureHostProxy(port: number): Promise<void> {
    const pub = this.publicPort(port);
    const file = `/tmp/friday-hostproxy-${pub}.mjs`;
    const logFile = `/tmp/friday-hostproxy-${pub}.log`;
    const pidFile = `/tmp/friday-hostproxy-${pub}.pid`;
    const script = `
import http from "node:http";
import net from "node:net";
const TARGET_PORT = ${port};
const PUBLIC_PORT = ${pub};
const hostHeader = "localhost:" + TARGET_PORT;
const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: hostHeader };
  const proxyReq = http.request({ host: "127.0.0.1", port: TARGET_PORT, path: req.url, method: req.method, headers }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("proxy error"); });
  req.pipe(proxyReq);
});
server.on("upgrade", (req, clientSocket, head) => {
  const serverSocket = net.connect(TARGET_PORT, "127.0.0.1", () => {
    const headerLines = Object.entries(req.headers).map(([k, v]) => (k.toLowerCase() === "host" ? "host: " + hostHeader : k + ": " + v));
    serverSocket.write(req.method + " " + req.url + " HTTP/1.1\\r\\n" + headerLines.join("\\r\\n") + "\\r\\n\\r\\n");
    if (head && head.length) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  serverSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => serverSocket.destroy());
});
server.listen(PUBLIC_PORT, "0.0.0.0");
`;
    await this.sandbox.commands
      .run(`test -f ${pidFile} && kill -TERM -$(cat ${pidFile}) 2>/dev/null; sleep 0.2; fuser -k ${pub}/tcp >/dev/null 2>&1; true`)
      .catch(() => {});
    await this.sandbox.files.write(file, script);
    const launch = `echo $$ > ${pidFile}; exec node ${file} > ${logFile} 2>&1`;
    await this.sandbox.commands.run(`setsid bash -c ${JSON.stringify(launch)}`, { background: true });
  }

  /** True once the proxy on `publicPort(port)` answers (i.e. the public preview URL will actually work). */
  async proxyUp(port: number): Promise<boolean> {
    const probe = await this.sandbox.commands
      .run(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${this.publicPort(port)}/ || true`, { timeoutMs: 8000 })
      .catch(() => null);
    const code = Number(probe?.stdout.trim() ?? 0);
    return code >= 200 && code < 500;
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
      envs: { ...this.projectEnv, ...VITE_HOSTS_ENV, HOST: "0.0.0.0", BROWSER: "none", FORCE_COLOR: "0" },
    });

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const probe = await this.sandbox.commands
        .run(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/ || true`, { timeoutMs: 8000 })
        .catch(() => null);
      const code = Number(probe?.stdout.trim() ?? 0);
      if (code >= 200 && code < 500) {
        // The dev server itself answers — now put the host-rewriting proxy in front of it, so the
        // PUBLIC url is immune to "Blocked request" no matter what the project's own config says.
        await this.ensureHostProxy(port).catch(() => {});
        let proxyOk = false;
        for (let i = 0; i < 6 && !proxyOk; i++) {
          await new Promise((r) => setTimeout(r, 800));
          proxyOk = await this.proxyUp(port);
        }
        const log = await this.logTail(logFile);
        if (proxyOk) {
          return { ready: true, url: `https://${this.sandbox.getHost(this.publicPort(port))}`, log };
        }
        // Proxy failed to come up (shouldn't happen — pure Node core modules) — fall back to the old
        // direct-to-dev-server path and the vite.config patch as a second line of defense.
        if (await this.hostBlocked(port)) {
          await this.allowPreviewHosts().catch(() => {});
          await new Promise((r) => setTimeout(r, 3500)); // Vite restarts itself when its config changes
        }
        const stillBlocked = await this.hostBlocked(port);
        return {
          ready: true,
          url: `https://${this.sandbox.getHost(port)}`,
          log: stillBlocked ? `${log}\nWARNING: the preview host is still blocked by the dev server — set server.allowedHosts: true in the Vite config.` : log,
        };
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
// The PUBLIC preview address — exactly what the user's preview pane loads. localhost is always allowed by the
// dev server, so checking it hid "Blocked request" pages and proxy problems from the agent.
let target = "https://${this.sandbox.getHost(this.publicPort(port))}/";
try { await page.goto(target, { waitUntil: "networkidle", timeout: 30000 }); }
catch (e) {
  errors.push("public preview URL failed (" + e.message.slice(0, 120) + ") — fell back to localhost");
  target = "http://localhost:${port}/";
  try { await page.goto(target, { waitUntil: "networkidle", timeout: 25000 }); } catch (e2) { errors.push("navigation: " + e2.message.slice(0, 200)); }
}
await page.waitForTimeout(1200);
const shownText = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 400) : ""));
if (/Blocked request|host .{0,60}is not allowed/i.test(shownText)) errors.push("The preview page shows Vite's 'Blocked request' error: add server.allowedHosts: true (and preview.allowedHosts: true) to the Vite config and restart the dev server.");
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
  box.useEnv(await loadSecrets(conversationId));
  const { port, start_cmd: startCmd } = project;

  if (!box.fresh && (await box.isServing(port))) {
    // The dev server survived (resumed sandbox) but the host-rewriting proxy is a separate process —
    // make sure IT is still up too before handing back a URL that routes through it.
    if (!(await box.proxyUp(port))) await box.ensureHostProxy(port).catch(() => {});
    if (await box.proxyUp(port)) return { url: box.previewUrl(port), port };
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
