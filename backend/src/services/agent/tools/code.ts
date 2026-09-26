import { env } from "../../../config/env.js";
import { runCode, type RunLanguage } from "../../e2bService.js";
import { recordUsageEvent } from "../../usageService.js";
import { clip, str, type FridayTool } from "./types.js";

const LANGUAGES: RunLanguage[] = ["python", "javascript", "typescript", "bash"];

/** Code interpreter: runs code in a fresh, isolated E2B microVM (killed right after) and returns its output. */
export const runCodeTool: FridayTool = {
  spec: {
    name: "run_code",
    description:
      "Execute code in an isolated sandbox and get its real output (stdout, stderr, errors). Use it for calculations, data " +
      "analysis, parsing, conversions, verifying an algorithm, or anything where running code beats guessing. Python has " +
      "numpy/pandas/matplotlib-style scientific packages; the sandbox has internet access and is discarded after the run. " +
      "Print what you need to see.",
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", enum: LANGUAGES, description: "Default python" },
        code: { type: "string", description: "The complete program to run" },
      },
      required: ["code"],
    },
  },
  label: (args) => `Ran ${str(args, "language") || "python"} code`,
  async run(args, ctx) {
    const code = str(args, "code");
    if (!code) throw new Error("code is required");
    const language = (LANGUAGES as string[]).includes(str(args, "language")) ? (str(args, "language") as RunLanguage) : "python";
    void recordUsageEvent(ctx.userId, "sandbox_run", 1, { language, viaTools: true });
    const result = await runCode(ctx.userId, language, code);
    return clip(`${result.ok ? "Exit: success" : "Exit: error"}\n${result.output}`, 12_000);
  },
};

export function codeTools(): FridayTool[] {
  return env.e2bApiKey ? [runCodeTool] : [];
}
