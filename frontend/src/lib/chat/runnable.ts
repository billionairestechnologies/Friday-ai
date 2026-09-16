import { api } from "@/lib/api";

export type RunLanguage = "python" | "javascript";

export type RunResult = {
  output: string;
  ok: boolean;
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

/** Runs a code snippet for real in the user's own isolated CodeSandbox VM and returns its output. */
export async function runSandboxCode(language: RunLanguage, code: string): Promise<RunResult> {
  return api.post<RunResult>("/sandbox/run", { language, code });
}
