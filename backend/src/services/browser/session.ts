import { Sandbox } from "@e2b/code-interpreter";
import { env } from "../../config/env.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { DAEMON_SOURCE } from "./daemon.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { chargeAwake } from "../air/awake.js";

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

/** Air Dots conversations pay for browser time from the daily awake minutes, like their sandbox. */
async function airOwner(conversationId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from("conversations").select("user_id, origin").eq("id", conversationId).maybeSingle();
  const row = data as { user_id?: string; origin?: string } | null;
  return row?.origin === "air" && row.user_id ? row.user_id : null;
}

/** The browser's sandbox id is kept in browser_sessions so any instance can reach it (the Air Dots
 *  screen may be served by a different server than the one the agent's turn ran on). */
async function rememberedSandbox(conversationId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from("browser_sessions").select("sandbox_id").eq("conversation_id", conversationId).maybeSingle();
  return (data as { sandbox_id?: string } | null)?.sandbox_id ?? null;
}

/** Air Dots: the person's one computer (air_machines). Everything else: one browser per chat. */
async function rememberedMachine(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from("air_machines").select("sandbox_id").eq("user_id", userId).maybeSingle();
  return (data as { sandbox_id?: string } | null)?.sandbox_id ?? null;
}

async function createMachine(apiKey: string, persistent: boolean): Promise<Sandbox> {
  if (!persistent) return Sandbox.create({ apiKey, timeoutMs: BROWSER_TTL_MS });
  // Pause instead of dying on idle, so the person's sign-ins survive; opening it again resumes it.
  return Sandbox.create({ apiKey, timeoutMs: BROWSER_TTL_MS, lifecycle: { onTimeout: "pause", autoResume: true } }).catch(() =>
    Sandbox.create({ apiKey, timeoutMs: BROWSER_TTL_MS }),
  );
}

async function sandboxFor(conversationId: string, opts: { create?: boolean } = {}): Promise<Sandbox> {
  if (!env.e2bApiKey) throw new HttpError(503, "The browser needs E2B_API_KEY on the server.");
  const owner = await airOwner(conversationId);
  // The session key: the person's machine for Air Dots, the chat for everything else.
  const key = owner ? `user:${owner}` : conversationId;
  if (owner) await chargeAwake(owner, `machine:${owner}`, BROWSER_TTL_MS);
  if (!sessions.has(key)) {
    const remembered = owner ? await rememberedMachine(owner) : await rememberedSandbox(conversationId);
    if (remembered) sessions.set(key, { sandboxId: remembered, ready: Promise.resolve() });
  }
  return connectOrCreate(key, conversationId, owner, opts);
}

async function connectOrCreate(key: string, conversationId: string, owner: string | null, opts: { create?: boolean }): Promise<Sandbox> {
  if (!env.e2bApiKey) throw new HttpError(503, "The browser needs E2B_API_KEY on the server.");
  const existing = sessions.get(key);
  if (existing) {
    try {
      const sb = await Sandbox.connect(existing.sandboxId, { apiKey: env.e2bApiKey });
      await sb.setTimeout(BROWSER_TTL_MS).catch(() => undefined);
      await existing.ready;
      return sb;
    } catch {
      sessions.delete(key);
    }
  }
  if (opts.create === false) throw new HttpError(404, "No browser is open for this chat yet.");
  const sb = await createMachine(env.e2bApiKey, Boolean(owner));
  if (owner) await supabaseAdmin.from("air_machines").upsert({ user_id: owner, sandbox_id: sb.sandboxId, updated_at: new Date().toISOString() }).then(() => undefined, () => undefined);
  else await supabaseAdmin.from("browser_sessions").upsert({ conversation_id: conversationId, sandbox_id: sb.sandboxId, updated_at: new Date().toISOString() }).then(() => undefined, () => undefined);
  const ready = setup(sb);
  sessions.set(key, { sandboxId: sb.sandboxId, ready });
  try {
    await ready;
  } catch (err) {
    sessions.delete(key);
    await sb.kill().catch(() => undefined);
    throw err;
  }
  return sb;
}

/** Runs one browser action and returns the page snapshot (or a base64 JPEG for "screenshot"). */
export async function browserAction(conversationId: string, command: Record<string, unknown>, opts: { create?: boolean } = {}): Promise<Snapshot> {
  const sb = await sandboxFor(conversationId, opts);
  // The command travels as a file, never through shell quoting.
  const file = `${DIR}/cmd-${Date.now().toString(36)}.json`;
  // Each chat drives its own tab; on the shared Air Dots machine that keeps dots off each other's page.
  await sb.files.write(file, JSON.stringify({ ...command, tab: conversationId }));
  const out = await sb.commands
    .run(`curl -s -m 55 -X POST --data-binary @${file} http://127.0.0.1:7777/ ; rm -f ${file}`, { timeoutMs: 60_000 })
    .catch((err: { stdout?: string; message?: string }) => ({ stdout: err.stdout ?? "", error: err.message }));
  try {
    return JSON.parse(out.stdout) as Snapshot;
  } catch {
    // The daemon died (a page crashed Chromium): forget the session so the next call starts fresh.
    for (const [k, v] of sessions) if (v.sandboxId === sb.sandboxId) sessions.delete(k);
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

/** Team Console "Pause computer": pause the person's Air Dots machine (work and sign-ins kept). */
export async function pauseAirMachine(userId: string): Promise<boolean> {
  if (!env.e2bApiKey) return false;
  const id = await rememberedMachine(userId);
  for (const [k, v] of sessions) if (k === `user:${userId}` || v.sandboxId === id) sessions.delete(k);
  if (!id) return false;
  const sb = await Sandbox.connect(id, { apiKey: env.e2bApiKey }).catch(() => null);
  if (!sb) return false;
  return (sb as unknown as { pause: () => Promise<unknown> }).pause().then(() => true).catch(() => false);
}

export async function airMachineId(userId: string): Promise<string | null> {
  return rememberedMachine(userId);
}
