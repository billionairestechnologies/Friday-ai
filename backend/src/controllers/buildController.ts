import type { Request, Response } from "express";
import JSZip from "jszip";
import { getOwnedConversation } from "../services/chat/conversations.js";
import { ensurePreview, getProject } from "../services/projectBuild/sandbox.js";
import { listBuildSessions } from "../services/projectBuild/sessions.js";
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
