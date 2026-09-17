import { api } from "@/lib/api";

export type RunLanguage = "python" | "javascript";

export type RunResult = {
  output: string;
  ok: boolean;
};

export type RunAttempt = {
  code: string;
  result: RunResult;
};

export type AutoRunResult = RunResult & {
  /** The code that actually ran last — unchanged unless the backend's auto-fix loop rewrote it. */
  code: string;
  attempts: RunAttempt[];
};

const LANG_ALIASES: Record<string, RunLanguage> = {
  python: "python",
  py: "python",
  javascript: "javascript",
  js: "javascript",
};

export function normalizeRunLanguage(lang?: string): RunLanguage | null {
  if (!lang) return null;
  return LANG_ALIASES[lang.toLowerCase()] ?? null;
}

/** Runs a code snippet for real in the user's own isolated E2B VM. On failure, the backend
 *  automatically asks a model to fix it and retries (see e2bService's runWithAutoFix) unless
 *  autoFix is explicitly turned off — the returned `code` reflects whatever actually ran last. */
export async function runSandboxCode(
  language: RunLanguage,
  code: string,
  autoFix = true,
): Promise<AutoRunResult> {
  return api.post<AutoRunResult>("/sandbox/run", { language, code, autoFix });
}
