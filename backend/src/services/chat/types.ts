export type StreamEvent =
  | { t: "status"; s: "thinking" | "searching" | "synthesizing" }
  | { t: "agent"; slug: string; model: string; state: "start" | "done" | "error"; error?: string }
  | { t: "text"; c: string }
  | { t: "think"; c: string }
  | { t: "cite"; u: string; title?: string }
  | { t: "err"; c: string }
  | { t: "done" };

export type ConversationMode = "single" | "auto" | "teamup";
