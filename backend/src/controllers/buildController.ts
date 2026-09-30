import type { Request, Response } from "express";
import JSZip from "jszip";
import { getOwnedConversation } from "../services/chat/conversations.js";
import { ensurePreview, getProject } from "../services/projectBuild/sandbox.js";
import { listBuildSessions } from "../services/projectBuild/sessions.js";
import { listPendingApprovals, resolveApproval } from "../services/projectBuild/approvals.js";
import { listCheckpoints, restoreCheckpoint } from "../services/projectBuild/checkpoints.js";
import { readEvents } from "../services/projectBuild/events.js";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler.js";

async function ownedProject(req: Request) {
  await getOwnedConversation(req.user!.id, req.params.conversationId!);
  const project = await getProject(req.params.conversationId!);
  if (!project) throw new HttpError(404, "No project has been built in this chat yet");
  return project;
}

/** The Build workspace's session list (home screen + sidebar), with live status per session. */
export async function sessions(req: Request, res: Response) {
  res.json({ sessions: await listBuildSessions(req.user!.id) });
}

/** Approval prompts this build is waiting on (for a device that wasn't watching when they appeared). */
export async function approvals(req: Request, res: Response) {
  await getOwnedConversation(req.user!.id, req.params.conversationId!);
  res.json({ approvals: listPendingApprovals(req.params.conversationId!, req.user!.id) });
}

const approveSchema = z.object({ id: z.string().min(1).max(64), decision: z.enum(["allow", "deny", "allow_all"]) });

/** The user's Allow / Deny (or Allow all for this build) on a pending prompt. */
export async function approve(req: Request, res: Response) {
  await getOwnedConversation(req.user!.id, req.params.conversationId!);
  const { id, decision } = approveSchema.parse(req.body);
  if (!resolveApproval(req.params.conversationId!, req.user!.id, id, decision)) {
    throw new HttpError(409, "That request is no longer waiting — the build may have moved on or been stopped.");
  }
  res.json({ ok: true });
}

/** The current turn's event log after `after` — replay + live follow for a device that wasn't connected. */
export async function events(req: Request, res: Response) {
  await getOwnedConversation(req.user!.id, req.params.conversationId!);
  const { after } = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  res.json(await readEvents(req.params.conversationId!, after));
}

/** Which user messages have a restore point (the files before that turn). */
export async function checkpoints(req: Request, res: Response) {
  await getOwnedConversation(req.user!.id, req.params.conversationId!);
  res.json({ checkpoints: await listCheckpoints(req.params.conversationId!) });
}

/** "Restore to before this message": files back to that point, conversation rewound to just before it. */
export async function restore(req: Request, res: Response) {
  await getOwnedConversation(req.user!.id, req.params.conversationId!);
  const { messageId } = z.object({ messageId: z.string().uuid() }).parse(req.body);
  res.json({ ok: true, ...(await restoreCheckpoint(req.user!.id, req.params.conversationId!, messageId)) });
}

/** Restores/refreshes the live preview (sandboxes are short-lived) and returns its URL. */
export async function preview(req: Request, res: Response) {
  await ownedProject(req);
  res.json(await ensurePreview(req.user!.id, req.params.conversationId!));
}

export async function files(req: Request, res: Response) {
  const project = await ownedProject(req);
  res.json({ files: project.files, startCmd: project.start_cmd, port: project.port });
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
