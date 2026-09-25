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
  kind: "write" | "run" | "start" | "read" | "note";
  label: string;
  state: "running" | "ok" | "error";
  detail?: string;
};

export type BuildPlanItem = { text: string; state: "todo" | "doing" | "done" };
export type BuildPlan = { architecture: string; items: BuildPlanItem[] };

/** What Build Mode did for a message: the steps it ran and the live preview it produced. */
export type BuildInfo = {
  plan?: BuildPlan;
  steps: BuildStep[];
  previewUrl?: string;
  port?: number;
  elapsedMs?: number;
  zipBytes?: number;
  zipName?: string;
};

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
  | { t: "step"; id: string; kind: BuildStep["kind"]; label: string; state: BuildStep["state"]; detail?: string }
  | { t: "preview"; url: string; port: number }
  | { t: "build"; elapsedMs?: number; zipBytes?: number; zipName?: string }
  | { t: "plan"; architecture: string; items: BuildPlanItem[] }
  | { t: "err"; c: string }
  | { t: "done" };
