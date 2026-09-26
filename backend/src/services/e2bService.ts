import { Sandbox } from "@e2b/code-interpreter";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errorHandler.js";
import { fixCode } from "./chat/codeFix.js";

export type RunLanguage = "python" | "javascript" | "typescript" | "r" | "java" | "bash";

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

// One real E2B microVM per run — hardware-level isolation between users' code. Nothing is kept:
// the sandbox is created when code runs and killed (never paused) as soon as it finishes, so no
// user data lingers in E2B. Anything that must persist belongs in our own database.
const SANDBOX_TIMEOUT_MS = 10 * 60 * 1000;

function requireApiKey(): string {
  if (!env.e2bApiKey) {
    throw new HttpError(503, "Code execution isn't configured yet — missing E2B_API_KEY.");
  }
  return env.e2bApiKey;
}

/**
 * Runs a one-shot code snippet in this user's isolated sandbox and returns its combined
 * output. This is real execution — an actual interpreter running in a real VM — not a
 * client-side preview, so it can do things Canvas's iframe never could: read/write files,
 * install packages, hit the network, run for more than a render tick.
 */
export async function runCode(_userId: string, language: RunLanguage, code: string): Promise<RunResult> {
  const apiKey = requireApiKey();
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create({ apiKey, timeoutMs: SANDBOX_TIMEOUT_MS });
  } catch (err) {
    return { output: err instanceof Error ? err.message : "Couldn't start a sandbox", ok: false };
  }

  try {
    const execution = await sandbox.runCode(code, { language });

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
  } finally {
    await sandbox.kill().catch(() => {});
  }
}

// Not truly unbounded — one HTTP request is holding the line open for every attempt (sandbox
// run + a model fix call, back to back), and a browser/proxy timeout would kill the request and
// hand the user nothing at all, which is worse than a bounded "still couldn't fix it" result.
// 25 is high enough that in practice the real stop condition below (a fix that repeats one
// already tried, i.e. the model is out of new ideas) is what ends the loop, not this number.
const MAX_FIX_ATTEMPTS = 25;

/**
 * Runs code for real, and on failure asks a model to fix it and tries again — genuinely "until
 * it stops working", not an arbitrary small cap: it keeps going as long as each fix attempt is
 * actually new. It only gives up when the model repeats a fix already tried (stuck oscillating,
 * not making progress) or returns nothing, or MAX_FIX_ATTEMPTS is hit as a last-resort ceiling.
 */
export async function runWithAutoFix(
  userId: string,
  language: RunLanguage,
  code: string,
): Promise<AutoRunResult> {
  let currentCode = code;
  const attempts: RunAttempt[] = [];
  const tried = new Set<string>([code]);

  for (let i = 0; i <= MAX_FIX_ATTEMPTS; i++) {
    const result = await runCode(userId, language, currentCode);
    attempts.push({ code: currentCode, result });
    if (result.ok || i === MAX_FIX_ATTEMPTS) {
      return { ok: result.ok, output: result.output, code: currentCode, attempts };
    }
    const fixed = await fixCode(language, currentCode, result.output);
    if (!fixed || tried.has(fixed)) {
      return { ok: false, output: result.output, code: currentCode, attempts };
    }
    tried.add(fixed);
    currentCode = fixed;
  }

  // Unreachable — the loop above always returns by the time i === MAX_FIX_ATTEMPTS.
  const last = attempts[attempts.length - 1]!;
  return { ok: last.result.ok, output: last.result.output, code: currentCode, attempts };
}
