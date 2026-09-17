import { Sandbox } from "@e2b/code-interpreter";
import { supabaseAdmin } from "../config/supabase.js";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errorHandler.js";
import { fixCode } from "./chat/codeFix.js";

export type RunLanguage = "python" | "javascript";

export interface RunResult {
  output: string;
  ok: boolean;
}

export interface RunAttempt {
  code: string;
  result: RunResult;
}

export interface AutoRunResult {
  ok: boolean;
  output: string;
  /** The code that was actually run last — identical to the input unless auto-fix rewrote it. */
  code: string;
  /** One entry per attempt, in order, so the UI can show "attempt 1 failed, fixed, attempt 2
   *  passed" instead of just the final result. Always has at least one entry. */
  attempts: RunAttempt[];
}

// One real E2B microVM per user — actual hardware-level isolation between users' code, not
// just a shared process running everyone's snippets. Reused across runs (not recreated each
// time) via pause()/connect() (which auto-resumes a paused sandbox), so installed packages and
// file state persist between messages without paying for idle compute between them.
const SANDBOX_TIMEOUT_MS = 15 * 60 * 1000;

function requireApiKey(): string {
  if (!env.e2bApiKey) {
    throw new HttpError(503, "Code execution isn't configured yet — missing E2B_API_KEY.");
  }
  return env.e2bApiKey;
}

async function getStoredSandboxId(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("user_sandboxes")
    .select("sandbox_id")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.sandbox_id ?? null;
}

async function rememberSandbox(userId: string, sandboxId: string): Promise<void> {
  await supabaseAdmin
    .from("user_sandboxes")
    .upsert({ user_id: userId, sandbox_id: sandboxId, last_used_at: new Date().toISOString() });
}

/**
 * Gets this user's sandbox, connecting to (and auto-resuming, if paused) the one on record, or
 * creating a brand new one on first use. A connect failure on a stale stored ID (e.g. it expired
 * past E2B's retention window) falls back to creating a fresh one instead of hard-failing the run.
 */
async function getOrCreateSandbox(apiKey: string, userId: string): Promise<Sandbox> {
  const existingId = await getStoredSandboxId(userId);
  if (existingId) {
    try {
      return await Sandbox.connect(existingId, { apiKey });
    } catch {
      // Fall through to creating a new one — the stored sandbox is gone or unreachable.
    }
  }

  const sandbox = await Sandbox.create({ apiKey, timeoutMs: SANDBOX_TIMEOUT_MS });
  await rememberSandbox(userId, sandbox.sandboxId);
  return sandbox;
}

/**
 * Runs a one-shot code snippet in this user's isolated sandbox and returns its combined
 * output. This is real execution — an actual interpreter running in a real VM — not a
 * client-side preview, so it can do things Canvas's iframe never could: read/write files,
 * install packages, hit the network, run for more than a render tick.
 */
export async function runCode(userId: string, language: RunLanguage, code: string): Promise<RunResult> {
  const apiKey = requireApiKey();
  const sandbox = await getOrCreateSandbox(apiKey, userId);

  try {
    const execution = await sandbox.runCode(code, { language });
    await rememberSandbox(userId, sandbox.sandboxId);
    // Pausing (not killing) frees the compute between runs while keeping installed packages
    // and file state — connect() above transparently resumes it next time this user runs code.
    await sandbox.pause().catch(() => {
      /* best-effort — an unpaused sandbox just idles until its own timeout, not a real failure */
    });

    const printed = [...execution.logs.stdout, ...execution.logs.stderr].filter(Boolean).join("\n");

    if (execution.error) {
      // Whatever printed before the exception is still real output the user should see —
      // dropping it would make a script that printed progress then crashed look like it
      // produced nothing at all before failing.
      const { name, value, traceback } = execution.error;
      const errorText = `${name}: ${value}\n${traceback}`;
      return { output: printed ? `${printed}\n${errorText}` : errorText, ok: false };
    }

    const output = [printed, execution.text].filter(Boolean).join("\n");
    return { output: output || "(no output)", ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sandbox run failed";
    return { output: message, ok: false };
  }
}

// Caps the self-healing loop at 2 fix rounds (3 sandbox runs total) — enough to catch the
// syntax-error/typo class of bug a model usually introduces, without letting one bad script
// burn unbounded sandbox time and LLM calls if it's wrong in a way that can't be auto-fixed.
const MAX_FIX_ATTEMPTS = 2;

/**
 * Runs code for real, and on failure asks a model to fix it and tries again — up to
 * MAX_FIX_ATTEMPTS times — instead of just handing the user a stack trace. Stops early if a fix
 * attempt comes back empty (the model couldn't produce a fix) rather than looping on nothing.
 */
export async function runWithAutoFix(
  userId: string,
  language: RunLanguage,
  code: string,
): Promise<AutoRunResult> {
  let currentCode = code;
  const attempts: RunAttempt[] = [];

  for (let i = 0; i <= MAX_FIX_ATTEMPTS; i++) {
    const result = await runCode(userId, language, currentCode);
    attempts.push({ code: currentCode, result });
    if (result.ok || i === MAX_FIX_ATTEMPTS) {
      return { ok: result.ok, output: result.output, code: currentCode, attempts };
    }
    const fixed = await fixCode(language, currentCode, result.output);
    if (!fixed || fixed === currentCode) {
      return { ok: false, output: result.output, code: currentCode, attempts };
    }
    currentCode = fixed;
  }

  // Unreachable — the loop above always returns by the time i === MAX_FIX_ATTEMPTS.
  const last = attempts[attempts.length - 1]!;
  return { ok: last.result.ok, output: last.result.output, code: currentCode, attempts };
}
