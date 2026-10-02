import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { isGenerating } from "../chat/activeGenerations.js";
import { runningAmong } from "../jobs/turns.js";
import { hasPendingApproval } from "./approvals.js";
import type { BuildMeta } from "../chat/types.js";

/**
 * The Build workspace's home + sidebar list (like Claude Code's "Sessions"): every build session with a
 * live status the user can act on — running now, waiting on them (a plan to approve or questions to
 * answer), finished, or failed — plus the repo it works on and the pull request it opened, if any.
 */
export type BuildSessionStatus = "running" | "needs_input" | "done" | "error" | "idle";

export type BuildSessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  status: BuildSessionStatus;
  /** One line under the title: what's happening / what it's waiting on / the last reply. */
  activity: string;
  repo: string | null;
  prUrl: string | null;
  previewUrl: string | null;
};

const LIMIT = 40;

function firstLine(text: string, max = 140): string {
  const line = text.replace(/[#*_`>]/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export async function listBuildSessions(userId: string): Promise<BuildSessionSummary[]> {
  const { data: conversations, error } = await supabaseAdmin
    .from("conversations")
    .select("id, title, updated_at, workspace, build_projects(repo)")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) throw new HttpError(500, error.message);

  // Build sessions, plus older chats that made a project before Build had its own tab.
  const sessions = (conversations ?? [])
    .map((c) => {
      const bp = c.build_projects as { repo?: string | null } | { repo?: string | null }[] | null;
      const project = Array.isArray(bp) ? bp[0] : bp;
      return { ...c, project: project ?? null };
    })
    .filter((c) => (c as { workspace?: string }).workspace === "build" || c.project)
    .slice(0, LIMIT);
  if (sessions.length === 0) return [];
  const ids = sessions.map((s) => s.id as string);

  const [lastByConversation, prs] = await Promise.all([
    Promise.all(
      ids.map(async (id) => {
        const { data } = await supabaseAdmin
          .from("messages")
          .select("role, content, build, error, created_at")
          .eq("conversation_id", id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return [id, data] as const;
      }),
    ),
    supabaseAdmin
      .from("messages")
      .select("conversation_id, build, created_at")
      .in("conversation_id", ids)
      .not("build->>prUrl", "is", null)
      .order("created_at", { ascending: false }),
  ]);
  const last = new Map(lastByConversation);
  // Running = a fresh heartbeat from ANY instance (jobs/turns.ts), not just this process.
  const running = await runningAmong(ids).catch(() => new Set<string>());
  const prByConversation = new Map<string, string>();
  for (const row of prs.data ?? []) {
    const url = (row.build as BuildMeta | null)?.prUrl;
    if (url && !prByConversation.has(row.conversation_id as string)) prByConversation.set(row.conversation_id as string, url);
  }

  return sessions.map((s) => {
    const id = s.id as string;
    const msg = last.get(id) as { role: string; content: string; build: BuildMeta | null; error: string | null } | null | undefined;
    const build = msg?.build ?? null;
    let status: BuildSessionStatus;
    let activity: string;
    if (hasPendingApproval(id)) {
      status = "needs_input";
      activity = "Waiting for your permission to continue";
    } else if (isGenerating(id) || running.has(id)) {
      status = "running";
      activity = "Working on it…";
    } else if (msg?.role === "assistant" && build?.plan?.status === "pending") {
      status = "needs_input";
      activity = "Waiting for you to approve the plan";
    } else if (msg?.role === "assistant" && build?.ask?.length) {
      status = "needs_input";
      activity = "Waiting for your answers";
    } else if (msg?.role === "assistant" && msg.error) {
      status = "error";
      activity = firstLine(msg.error);
    } else if (msg?.role === "assistant") {
      status = "done";
      activity = firstLine(msg.content) || "Done";
    } else {
      // Last message is the user's and nothing is generating: the turn was stopped or interrupted.
      status = "idle";
      activity = msg ? "Stopped — send a message to continue" : "No messages yet";
    }
    return {
      id,
      title: (s.title as string) || "New build",
      updatedAt: s.updated_at as string,
      status,
      activity,
      repo: s.project?.repo ?? null,
      prUrl: prByConversation.get(id) ?? null,
      previewUrl: build?.previewUrl ?? null,
    };
  });
}
