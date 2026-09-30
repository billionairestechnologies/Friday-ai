export type Role = "user" | "assistant";

export type Attachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "file";
  dataUrl: string;
};

export type Citation = {
  url: string;
  title?: string;
};

export type AssistantStatus =
  | "working"
  | "searching"
  | "thinking"
  | "synthesizing"
  | "writing"
  | "building"
  | "generating_image"
  | null;

export type AgentStatus = {
  slug: string;
  model: string;
  state: "start" | "done" | "error";
  error?: string;
};

export type BuildStep = {
  id: string;
  kind: "write" | "run" | "start" | "read" | "note" | "tool";
  label: string;
  state: "running" | "ok" | "error";
  detail?: string;
  /** Rich activity (v2 backend; absent on older messages): see backend chat/types.ts BuildStep. */
  cmd?: string;
  output?: string;
  exitCode?: number;
  path?: string;
  code?: string;
  lang?: string;
  added?: number;
  removed?: number;
  startedAt?: number;
  ms?: number;
};

/** A Build permission prompt (backend projectBuild/approvals.ts). */
export type BuildApproval = {
  id: string;
  kind: "file" | "command" | "connector" | "pr";
  title: string;
  detail?: string;
  /** Asks even in Full auto (pull requests, deploys, recursive deletes). */
  always?: boolean;
  createdAt: number;
  state: "pending" | "allowed" | "denied";
};

export type BuildPlanItem = { text: string; state: "todo" | "doing" | "done" };
export type BuildPlan = {
  architecture: string;
  items: BuildPlanItem[];
  /** Plain-language "what I'll build" (plans drafted for approval; absent on older ones). */
  summary?: string;
  /** Approval round: "pending" = waiting for the user to approve or ask for changes; "approved" =
   *  the build ran it; "revised" = a newer plan replaced it. Absent on older messages. */
  status?: "pending" | "approved" | "revised";
};

/** What Build Mode did for a message: the steps it ran and the live preview it produced. */
export type AskOption = { label: string; description?: string; recommended?: boolean };
export type AskQuestion = { id: string; question: string; options: AskOption[] };

export type BuildInfo = {
  /** Set when Build Mode is asking clarifying questions before it starts building. */
  ask?: AskQuestion[];
  plan?: BuildPlan;
  steps: BuildStep[];
  previewUrl?: string;
  port?: number;
  elapsedMs?: number;
  zipBytes?: number;
  zipName?: string;
  /** Pull request Build Mode opened (GitHub-imported projects). */
  prUrl?: string;
  /** Normal chat answered a build-shaped request — offer "Open in Build" with this prompt. */
  suggestBuild?: { prompt: string };
};

/** A file Friday generated for this reply (create_document) — shown as a download card. */
export type GeneratedFile = { id: string; title: string; filename: string; format: string; size: number; summary?: string; createdAt?: string };

export type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  thinking?: string;
  citations?: Citation[];
  attachments?: Attachment[];
  createdAt: number;
  streaming?: boolean;
  error?: string;
  status?: AssistantStatus;
  usedThink?: boolean;
  usedSearch?: boolean;
  usedCanvas?: boolean;
  /** Which provider/model produced this reply — shown above Team Up replies. */
  modelLabel?: string;
  /** Live per-model progress during a Team Up run — which models are answering and how it went. */
  agents?: AgentStatus[];
  build?: BuildInfo;
  files?: GeneratedFile[];
};

export type Chat = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** Backend conversation id (created lazily on first send). Absent for a brand-new local chat. */
  conversationId?: string;
  /** Encoded model id (or Auto/Team Up sentinel) the conversation is currently wired to on the backend. */
  conversationModel?: string;
  /** Set when this chat belongs to a Project — project chats are scoped-only: kept out of the
   *  main sidebar list and only shown from inside that project's own view. */
  projectId?: string;
  /** "build" = a Build workspace session (every message goes to the Build agent); listed in the
   *  Build workspace's own history instead of the main chat list. */
  workspace?: "build";
  /** Build Mode has produced a project in this chat (from any workspace) — also listed under Builds. */
  hasBuild?: boolean;
};

export type ChatRequestMessage = {
  role: Role;
  content: string;
  attachments?: Pick<Attachment, "kind" | "mime" | "name" | "dataUrl">[];
};

export type StreamEvent =
  | { t: "status"; s: "thinking" | "searching" | "synthesizing" | "writing" | "building" | "generating_image" }
  | { t: "agent"; slug: string; model: string; state: "start" | "done" | "error"; error?: string }
  | { t: "think"; c: string }
  | { t: "text"; c: string }
  | { t: "cite"; u: string; title?: string }
  | { t: "file"; file: GeneratedFile }
  | ({ t: "step" } & BuildStep)
  | { t: "preview"; url: string; port: number }
  | { t: "build"; elapsedMs?: number; zipBytes?: number; zipName?: string; prUrl?: string }
  | { t: "ask"; questions: AskQuestion[] }
  | { t: "plan"; architecture: string; items: BuildPlanItem[]; summary?: string; status?: BuildPlan["status"] }
  | { t: "suggest_build"; prompt: string }
  | ({ t: "approval" } & BuildApproval)
  | { t: "err"; c: string }
  | { t: "done" };
