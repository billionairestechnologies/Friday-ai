export type StreamEvent =
  | { t: "status"; s: "thinking" | "searching" | "synthesizing" | "writing" | "generating_image" }
  | { t: "agent"; slug: string; model: string; state: "start" | "done" | "error"; error?: string }
  | { t: "text"; c: string }
  | { t: "think"; c: string }
  | { t: "cite"; u: string; title?: string }
  | { t: "step"; id: string; kind: BuildStepKind; label: string; state: "running" | "ok" | "error"; detail?: string }
  | { t: "preview"; url: string; port: number }
  | { t: "err"; c: string }
  | { t: "done" };

export type ConversationMode = "single" | "auto" | "teamup";

export type BuildStepKind = "write" | "run" | "start" | "read";

/** What a Build Mode turn did — persisted on the message (`messages.build`) so it survives reloads. */
export type BuildStep = { id: string; kind: BuildStepKind; label: string; state: "running" | "ok" | "error"; detail?: string };
export type BuildMeta = {
  steps: BuildStep[];
  previewUrl?: string;
  port?: number;
  /** Wall-clock time of the whole build turn — shown as "Worked for 2m 41s". */
  elapsedMs?: number;
  /** Size + suggested name of the downloadable project zip (rendered as a file card in chat). */
  zipBytes?: number;
  zipName?: string;
};
