export type StreamEvent =
  | { t: "status"; s: "thinking" | "searching" | "synthesizing" | "writing" | "building" | "generating_image" }
  | { t: "agent"; slug: string; model: string; state: "start" | "done" | "error"; error?: string }
  | { t: "text"; c: string }
  | { t: "think"; c: string }
  | { t: "cite"; u: string; title?: string }
  /** A file a tool created this turn (create_document) — rendered as a download card. */
  | { t: "file"; file: import("../documents/documentService.js").GeneratedFile }
  | ({ t: "step" } & BuildStep)
  | { t: "preview"; url: string; port: number }
  | { t: "build"; elapsedMs?: number; zipBytes?: number; zipName?: string; prUrl?: string }
  | { t: "ask"; questions: AskQuestion[] }
  | { t: "plan"; architecture: string; items: BuildPlanItem[]; summary?: string; status?: BuildPlan["status"] }
  | { t: "suggest_build"; prompt: string }
  | { t: "err"; c: string }
  | { t: "done" };

export type ConversationMode = "single" | "auto" | "teamup";

/** Build workspace effort picker. low = quick (fewer rounds, no browser review), medium = default,
 *  high = the plan's full round budget plus extra verification passes. */
export type BuildEffort = "low" | "medium" | "high";

export type BuildStepKind = "write" | "run" | "start" | "read" | "note" | "tool";

/** What a Build Mode turn did — persisted on the message (`messages.build`) so it survives reloads. */
export type BuildStep = {
  id: string;
  kind: BuildStepKind;
  label: string;
  state: "running" | "ok" | "error";
  detail?: string;
  // Rich, optional activity fields (v2) so clients can show what is really happening — a live mini
  // terminal for commands, a code card for file writes/edits. Older clients ignore them and keep
  // using `detail`; every field is size-capped before it is sent or persisted.
  /** run/start: the exact shell command. */
  cmd?: string;
  /** run/start: output so far (tail), streamed live while the command runs. */
  output?: string;
  /** run: exit code once finished. */
  exitCode?: number;
  /** write/edit/read: project-relative file path. */
  path?: string;
  /** write: the start of the new file; edit: a -/+ diff of the change. */
  code?: string;
  /** Language hint for `code` (from the file extension); "diff" for edits. */
  lang?: string;
  /** write/edit: lines added / removed. */
  added?: number;
  removed?: number;
  /** Epoch ms when the step started — lets clients show a live elapsed timer. */
  startedAt?: number;
  /** Duration once finished. */
  ms?: number;
};
export type BuildPlanItem = { text: string; state: "todo" | "doing" | "done" };

/** The architecture + todo checklist Build Mode drafts before it starts (updated live as items finish). */
export type BuildPlan = {
  architecture: string;
  items: BuildPlanItem[];
  /** Plain-language "what I'll build" for the user (plans drafted for approval; absent on older ones). */
  summary?: string;
  /** Approval round: "pending" = waiting for the user; "approved" = the build ran it; "revised" = a
   *  newer plan replaced it. Absent = drafted and executed in one go (older messages). */
  status?: "pending" | "approved" | "revised";
};

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
  /** A normal-chat reply to something that looked like a build request: Build Mode only runs in the
   *  Build workspace, so the client offers "Open in Build" with this prompt. */
  suggestBuild?: { prompt: string };
};
