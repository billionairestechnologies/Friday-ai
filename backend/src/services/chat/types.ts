export type StreamEvent =
  | { t: "status"; s: "thinking" | "searching" | "synthesizing" | "writing" | "building" | "generating_image" }
  | { t: "agent"; slug: string; model: string; state: "start" | "done" | "error"; error?: string }
  | { t: "text"; c: string }
  | { t: "think"; c: string }
  | { t: "cite"; u: string; title?: string }
  | { t: "step"; id: string; kind: BuildStepKind; label: string; state: "running" | "ok" | "error"; detail?: string }
  | { t: "preview"; url: string; port: number }
  | { t: "build"; elapsedMs?: number; zipBytes?: number; zipName?: string; prUrl?: string }
  | { t: "ask"; questions: AskQuestion[] }
  | { t: "plan"; architecture: string; items: BuildPlanItem[] }
  | { t: "err"; c: string }
  | { t: "done" };

export type ConversationMode = "single" | "auto" | "teamup";

export type BuildStepKind = "write" | "run" | "start" | "read" | "note" | "tool";

/** What a Build Mode turn did — persisted on the message (`messages.build`) so it survives reloads. */
export type BuildStep = { id: string; kind: BuildStepKind; label: string; state: "running" | "ok" | "error"; detail?: string };
export type BuildPlanItem = { text: string; state: "todo" | "doing" | "done" };

/** The architecture + todo checklist Build Mode drafts before it starts (updated live as items finish). */
export type BuildPlan = { architecture: string; items: BuildPlanItem[] };

/** A clarifying question Build Mode asks before it starts. The first option is the recommended one;
 *  the client always adds a free-text "Other" after the listed options. */
export type AskOption = { label: string; description?: string; recommended?: boolean };
export type AskQuestion = { id: string; question: string; options: AskOption[] };

export type BuildMeta = {
  /** Set on the assistant message that asks questions instead of building. */
  ask?: AskQuestion[];
  plan?: BuildPlan;
  steps: BuildStep[];
  previewUrl?: string;
  port?: number;
  /** Wall-clock time of the whole build turn — shown as "Worked for 2m 41s". */
  elapsedMs?: number;
  /** Size + suggested name of the downloadable project zip (rendered as a file card in chat). */
  zipBytes?: number;
  zipName?: string;
  /** Pull request opened by the agent (GitHub-imported projects). */
  prUrl?: string;
};
