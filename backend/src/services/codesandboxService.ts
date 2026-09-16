import { CodeSandbox } from "@codesandbox/sdk";
import { supabaseAdmin } from "../config/supabase.js";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errorHandler.js";

export type RunLanguage = "python" | "javascript";

export interface RunResult {
  output: string;
  ok: boolean;
}

// One real Firecracker microVM per user — actual hardware-level isolation between users'
// code, not just a shared process running everyone's snippets. Reused across runs (not
// recreated each time) so installed packages and file state persist between messages; the
// VM hibernates itself after CodeSandbox's own inactivity timeout, which is cheap and resumes
// in ~2-3s, so there's no need to eagerly tear it down after every run.
const HIBERNATION_TIMEOUT_SECONDS = 15 * 60;

function getSdk(): CodeSandbox {
  if (!env.codesandboxApiKey) {
    throw new HttpError(503, "Code execution isn't configured yet — missing CODESANDBOX_API_KEY.");
  }
  return new CodeSandbox(env.codesandboxApiKey);
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
 * Gets this user's sandbox, resuming it if it already exists (near-instant if hibernated,
 * clean bootup if the hibernation snapshot expired) or creating a brand new one on first use.
 * A resume/create failure on a stale stored ID (e.g. it was deleted from the CodeSandbox
 * dashboard) falls back to creating a fresh one instead of hard-failing the run.
 */
async function getOrCreateSandbox(sdk: CodeSandbox, userId: string) {
  const existingId = await getStoredSandboxId(userId);
  if (existingId) {
    try {
      const sandbox = await sdk.sandboxes.resume(existingId);
      return sandbox;
    } catch {
      // Fall through to creating a new one — the stored sandbox is gone or unreachable.
    }
  }

  const sandbox = await sdk.sandboxes.create();
  await sandbox.updateHibernationTimeout(HIBERNATION_TIMEOUT_SECONDS);
  await rememberSandbox(userId, sandbox.id);
  return sandbox;
}

/**
 * Runs a one-shot code snippet in this user's isolated sandbox and returns its combined
 * output. This is real execution — an actual interpreter running in a real VM — not a
 * client-side preview, so it can do things Canvas's iframe never could: read/write files,
 * install packages, hit the network, run for more than a render tick.
 */
export async function runCode(userId: string, language: RunLanguage, code: string): Promise<RunResult> {
  const sdk = getSdk();
  const sandbox = await getOrCreateSandbox(sdk, userId);

  try {
    const client = await sandbox.connect();
    try {
      const output =
        language === "python" ? await client.interpreters.python(code) : await client.interpreters.javascript(code);
      await rememberSandbox(userId, sandbox.id);
      return { output, ok: true };
    } finally {
      await client.disconnect();
    }
  } catch (err) {
    // A non-zero exit (e.g. an uncaught Python exception) throws with the program's actual
    // stdout/stderr attached as `.output` (SandboxCommands' CommandError shape) — surface
    // that instead of a generic error, so the user sees their real stack trace/traceback.
    const output = (err as { output?: string })?.output;
    const message = err instanceof Error ? err.message : "Sandbox run failed";
    return { output: output || message, ok: false };
  }
}
