import type { Request, Response } from "express";
import { z } from "zod";
import JSZip from "jszip";
import { supabaseAdmin } from "../config/supabase.js";
import { createConversation, getOwnedConversation, insertUserMessage, listBuildSessions } from "../services/chat/conversations.js";
import { ensurePreview, getProject, saveProject } from "../services/projectBuild/sandbox.js";
import { resolveApproval } from "../services/projectBuild/approvals.js";
import { HttpError } from "../middleware/errorHandler.js";

async function ownedProject(req: Request) {
  await getOwnedConversation(req.user!.id, req.params.conversationId!);
  const project = await getProject(req.params.conversationId!);
  if (!project) throw new HttpError(404, "No project has been built in this chat yet");
  return project;
}

/** Restores/refreshes the live preview (sandboxes are short-lived) and returns its URL. */
export async function preview(req: Request, res: Response) {
  await ownedProject(req);
  res.json(await ensurePreview(req.user!.id, req.params.conversationId!));
}

export async function files(req: Request, res: Response) {
  const project = await ownedProject(req);
  res.json({
    files: project.files,
    startCmd: project.start_cmd,
    port: project.port,
    mode: project.mode ?? "auto",
    effort: project.effort ?? "medium",
    pendingApproval: project.pending_approval ?? null,
  });
}

export async function download(req: Request, res: Response) {
  const project = await ownedProject(req);
  const zip = new JSZip();
  for (const [path, content] of Object.entries(project.files)) zip.file(path, content);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  res.setHeader("Content-Type", "application/zip");
  const pkgName = (() => {
    try {
      return (JSON.parse(project.files["package.json"] ?? "{}") as { name?: string }).name;
    } catch {
      return undefined;
    }
  })();
  res.setHeader("Content-Disposition", `attachment; filename="${(pkgName ?? "project").replace(/[^\w.-]+/g, "-")}.zip"`);
  res.send(buffer);
}

/** Build sessions (conversations.kind = 'build'), separate from the regular chat list — the
 *  sidebar's "Build" section. */
export async function listSessions(req: Request, res: Response) {
  const { limit, before } = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), before: z.string().datetime().optional() }).parse(req.query);
  const sessions = await listBuildSessions(req.user!.id, { limit, before });
  res.json({ sessions });
}

const createSessionSchema = z.object({
  fromConversationId: z.string().uuid(),
  mode: z.enum(["manual", "edit_auto", "plan", "auto"]).optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
});

/**
 * Promotes a build-shaped message from a normal chat into its own Build Mode workspace: a new
 * `kind: 'build'` conversation. Doesn't touch the sandbox itself — the frontend gets the prompt
 * back and sends it as the new session's first message via the normal send-message flow, which is
 * what actually kicks off the sandbox agent (see chat/index.ts: any message in a 'build'
 * conversation always runs it).
 */
export async function createSession(req: Request, res: Response) {
  const { fromConversationId, mode, effort } = createSessionSchema.parse(req.body);
  await getOwnedConversation(req.user!.id, fromConversationId);
  const { data: lastUserMessage } = await supabaseAdmin
    .from("messages")
    .select("content")
    .eq("conversation_id", fromConversationId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const prompt = (lastUserMessage?.content as string | undefined) ?? "";
  if (!prompt) throw new HttpError(400, "That chat has no message to start Build Mode from yet.");

  const conversation = await createConversation(req.user!.id, "auto", undefined, undefined, undefined, undefined, "build");
  if (mode || effort) {
    await saveProject(req.user!.id, conversation.id as string, { mode, effort });
  }
  res.status(201).json({ conversationId: conversation.id, prompt });
}

const settingsSchema = z.object({
  mode: z.enum(["manual", "edit_auto", "plan", "auto"]).optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
});

/** Changes a build session's mode/effort mid-run — takes effect from the next agent action/turn. */
export async function updateSettings(req: Request, res: Response) {
  const patch = settingsSchema.parse(req.body);
  const conversation = await getOwnedConversation(req.user!.id, req.params.conversationId!);
  if ((conversation as { kind?: string }).kind !== "build") throw new HttpError(400, "Not a Build Mode session");
  await saveProject(req.user!.id, req.params.conversationId!, patch);
  res.json({ ok: true });
}

async function ownedBuildSession(req: Request) {
  const conversation = await getOwnedConversation(req.user!.id, req.params.conversationId!);
  if ((conversation as { kind?: string }).kind !== "build") throw new HttpError(400, "Not a Build Mode session");
}

/** Resolves a pending approval (Manual/Plan/Auto-risky-action gate — see agent.ts's requestApproval). */
export async function approve(req: Request, res: Response) {
  await ownedBuildSession(req);
  const resolved = resolveApproval(req.params.conversationId!, true);
  if (!resolved) throw new HttpError(409, "Nothing is waiting for approval right now.");
  res.json({ ok: true });
}

export async function reject(req: Request, res: Response) {
  await ownedBuildSession(req);
  const resolved = resolveApproval(req.params.conversationId!, false);
  if (!resolved) throw new HttpError(409, "Nothing is waiting for approval right now.");
  res.json({ ok: true });
}
