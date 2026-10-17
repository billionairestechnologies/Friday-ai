import type { ToolSpec } from "../../providers/toolCalling.js";

export type ToolContext = {
  userId: string;
  conversationId: string;
  signal?: AbortSignal;
  /** Lets a tool surface a source link (shown as a citation chip under the reply). */
  onCite?: (url: string, title?: string) => void;
  /** Lets a tool attach a file it created (shown as a download card under the reply). */
  onFile?: (file: import("../../documents/documentService.js").GeneratedFile) => void;
  /** Lets a tool put a generated image into the reply itself (the model never re-types the URL). */
  onImage?: (url: string, alt: string) => void;
  /** Lets a tool stream its own nested activity (e.g. sub-agent cards) as step rows. */
  onStep?: (step: import("../../chat/types.js").BuildStep) => void;
  /** Tokens a tool spent on its own model calls (sub-agents) — counted toward the turn's usage. */
  onUsage?: (usage: import("../../tokenUsage.js").TokenUsage) => void;
  /**
   * use_skill calls this when a USER skill is loaded: from then on the tool loop refuses every tool
   * outside the skill's declared capabilities (null = unrestricted, for first-party skills).
   */
  activateSkill?: (allowedTools: Set<string> | null, skillName: string) => void;
};

/** A tool the chat agent can call. `run` returns plain text for the model; throwing reports an error
 *  to the model (which can retry or explain) rather than failing the whole turn. */
export type FridayTool = {
  spec: ToolSpec;
  /** Short user-facing label for the live step row, e.g. `Searched the web · "rust async"`. */
  label: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
};

export function str(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : fallback;
}

export function num(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const v = Number(args[key]);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} characters]` : text;
}
