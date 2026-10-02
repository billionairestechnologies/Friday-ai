import { Sandbox } from "@e2b/code-interpreter";
import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { isTurnRunning } from "../jobs/turns.js";
import { getProject, saveProject } from "./sandbox.js";

/**
 * Checkpoints + restore (Claude Code's "restore to before this message"). Right before each Build
 * agent turn the project's files are copied into build_checkpoints, keyed by the user message that
 * started the turn. Restoring puts those files back, throws away the sandbox (the next preview or
 * build recreates it from the restored files) and rewinds the conversation to just before that
 * message — so the code and the chat agree about where the project is.
 */

export async function createCheckpoint(conversationId: string, messageId: string): Promise<void> {
  const project = await getProject(conversationId);
  const { error } = await supabaseAdmin.from("build_checkpoints").upsert(
    {
      conversation_id: conversationId,
      message_id: messageId,
      files: project?.files ?? {},
      start_cmd: project?.start_cmd ?? null,
      port: project?.port ?? null,
    },
    { onConflict: "message_id" },
  );
  // Never block the build on this — the worst case is one message without a restore point.
  if (error) console.error("[build] checkpoint failed:", error.message);
}

export type CheckpointSummary = { messageId: string; createdAt: string; fileCount: number };

export async function listCheckpoints(conversationId: string): Promise<CheckpointSummary[]> {
  const { data, error } = await supabaseAdmin
    .from("build_checkpoints")
    .select("message_id, created_at, files")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).map((row) => ({
    messageId: row.message_id as string,
    createdAt: row.created_at as string,
    fileCount: Object.keys((row.files as Record<string, string>) ?? {}).length,
  }));
}

export async function restoreCheckpoint(userId: string, conversationId: string, messageId: string): Promise<{ fileCount: number }> {
  if (await isTurnRunning(conversationId)) throw new HttpError(409, "Stop the build first — it's still running.");
  const { data: checkpoint } = await supabaseAdmin
    .from("build_checkpoints")
    .select("files, start_cmd, port")
    .eq("conversation_id", conversationId)
    .eq("message_id", messageId)
    .maybeSingle();
  if (!checkpoint) throw new HttpError(404, "There's no restore point for that message.");
  const { data: message } = await supabaseAdmin
    .from("messages")
    .select("created_at")
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (!message) throw new HttpError(404, "That message no longer exists.");

  // The running sandbox holds the newer files — kill it so nothing serves or reuses them.
  const project = await getProject(conversationId);
  if (project?.sandbox_id && env.e2bApiKey) {
    await Sandbox.connect(project.sandbox_id, { apiKey: env.e2bApiKey })
      .then((sb) => sb.kill())
      .catch(() => {});
  }
  const files = (checkpoint.files as Record<string, string>) ?? {};
  await saveProject(userId, conversationId, {
    files,
    sandbox_id: null,
    start_cmd: (checkpoint.start_cmd as string | null) ?? null,
    port: (checkpoint.port as number | null) ?? null,
  });

  // Rewind the conversation: that message and everything after it (their checkpoints cascade).
  const { error } = await supabaseAdmin
    .from("messages")
    .delete()
    .eq("conversation_id", conversationId)
    .gte("created_at", message.created_at as string);
  if (error) throw new HttpError(500, error.message);
  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  return { fileCount: Object.keys(files).length };
}
