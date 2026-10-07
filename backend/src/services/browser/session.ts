import { Sandbox } from "@e2b/code-interpreter";
import { env } from "../../config/env.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { DAEMON_SOURCE } from "./daemon.js";

/**
 * One real browser per conversation, inside an E2B sandbox (never on our servers: whatever a page
 * does runs in a throwaway microVM, and it can't reach our internal network). The sandbox and its
 * open tabs survive between messages for BROWSER_TTL_MS, so "now click the second result" works on
 * the page the last message left open.
 */
const BROWSER_TTL_MS = 10 * 60 * 1000;
const DIR = "/tmp/friday-browser";

type Session = { sandboxId: string; ready: Promise<void> };
const sessions = new Map<string, Session>();

export type Snapshot = {
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  elements?: string[];
  text?: string;
  more?: boolean;
  image?: string;
};

async function setup(sb: Sandbox): Promise<void> {
  const ready = await sb.commands.run(`test -f ${DIR}/.ready && echo y || true`).catch(() => null);
  if (!ready?.stdout.includes("y")) {
    // ~30-60 s the first time per sandbox: Playwright + Chromium + its system libraries.
    await sb.commands.run(
      `mkdir -p ${DIR} && cd ${DIR} && (test -f package.json || npm init -y >/dev/null) && npm i playwright-core@1 --no-audit --no-fund >/dev/null 2>&1 && npx playwright-core install chromium >/dev/null 2>&1 && (sudo npx playwright-core install-deps chromium >/dev/null 2>&1 || true) && touch ${DIR}/.ready`,
      { timeoutMs: 5 * 60_000 },
    );
  }
  await sb.files.write(`${DIR}/daemon.mjs`, DAEMON_SOURCE);
  const health = await sb.commands.run(`curl -s -m 2 http://127.0.0.1:7777/health || true`).catch(() => null);
  if (health?.stdout.trim() !== "ok") {
    await sb.commands.run(`cd ${DIR} && node daemon.mjs > daemon.log 2>&1`, { background: true });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const h = await sb.commands.run(`curl -s -m 2 http://127.0.0.1:7777/health || true`).catch(() => null);
      if (h?.stdout.trim() === "ok") return;
    }
    const log = await sb.commands.run(`tail -c 1500 ${DIR}/daemon.log || true`).catch(() => null);
    throw new Error(`The browser didn't start: ${log?.stdout ?? "no log"}`);
  }
}

async function sandboxFor(conversationId: string): Promise<Sandbox> {
  if (!env.e2bApiKey) throw new HttpError(503, "The browser needs E2B_API_KEY on the server.");
  const existing = sessions.get(conversationId);
  if (existing) {
    try {
      const sb = await Sandbox.connect(existing.sandboxId, { apiKey: env.e2bApiKey });
      await sb.setTimeout(BROWSER_TTL_MS).catch(() => undefined);
      await existing.ready;
      return sb;
    } catch {
      sessions.delete(conversationId);
    }
  }
  const sb = await Sandbox.create({ apiKey: env.e2bApiKey, timeoutMs: BROWSER_TTL_MS });
  const ready = setup(sb);
  sessions.set(conversationId, { sandboxId: sb.sandboxId, ready });
  try {
    await ready;
  } catch (err) {
    sessions.delete(conversationId);
    await sb.kill().catch(() => undefined);
    throw err;
  }
  return sb;
}

/** Runs one browser action and returns the page snapshot (or a base64 JPEG for "screenshot"). */
export async function browserAction(conversationId: string, command: Record<string, unknown>): Promise<Snapshot> {
  const sb = await sandboxFor(conversationId);
  // The command travels as a file, never through shell quoting.
  const file = `${DIR}/cmd-${Date.now().toString(36)}.json`;
  await sb.files.write(file, JSON.stringify(command));
  const out = await sb.commands
    .run(`curl -s -m 55 -X POST --data-binary @${file} http://127.0.0.1:7777/ ; rm -f ${file}`, { timeoutMs: 60_000 })
    .catch((err: { stdout?: string; message?: string }) => ({ stdout: err.stdout ?? "", error: err.message }));
  try {
    return JSON.parse(out.stdout) as Snapshot;
  } catch {
    // The daemon died (a page crashed Chromium): forget the session so the next call starts fresh.
    sessions.delete(conversationId);
    return { ok: false, error: "The browser stopped responding — try again (it will restart)." };
  }
}

export async function closeBrowser(conversationId: string): Promise<void> {
  const s = sessions.get(conversationId);
  sessions.delete(conversationId);
  if (!s || !env.e2bApiKey) return;
  await Sandbox.connect(s.sandboxId, { apiKey: env.e2bApiKey })
    .then((sb) => sb.kill())
    .catch(() => undefined);
}
