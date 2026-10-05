import type { Request, Response } from "express";
import { z } from "zod";
import * as chatService from "../services/chat/index.js";
import * as searchAndShare from "../services/chat/searchAndShare.js";
import { stopGeneration } from "../services/chat/activeGenerations.js";
import { runTurn } from "../services/jobs/runTurn.js";
import { requestStop } from "../services/jobs/turns.js";
import { readEvents } from "../services/projectBuild/events.js";
import { getOwnedConversation } from "../services/chat/conversations.js";
import { entitlementsFor } from "../services/quota/entitlements.js";

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().datetime().optional(),
});

const listConversationsQuerySchema = pageSchema.extend({
  projectId: z.string().uuid().optional(),
});

const createConversationSchema = z
  .object({
    mode: z.enum(["single", "auto", "teamup"]).optional().default("single"),
    providerSlug: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    title: z.string().trim().max(200).optional(),
    projectId: z.string().uuid().optional(),
    workspace: z.enum(["chat", "build"]).optional().default("chat"),
    origin: z.enum(["web", "air"]).optional().default("web"),
  })
  .refine((data) => data.mode !== "single" || (data.providerSlug && data.modelId), {
    message: "providerSlug and modelId are required for single mode",
  });

export async function createConversation(req: Request, res: Response) {
  const { mode, providerSlug, modelId, title, projectId, workspace, origin } = createConversationSchema.parse(req.body);
  if (origin === "air" && !(await entitlementsFor(req.user!.id)).airDots) {
    res.status(403).json({ error: "Air Dots isn't on your plan." });
    return;
  }
  const conversation = await chatService.createConversation(req.user!.id, mode, providerSlug, modelId, title, projectId, workspace, origin);
  res.status(201).json({ conversation });
}

const updateConversationSchema = z
  .object({
    mode: z.enum(["single", "auto", "teamup"]),
    providerSlug: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
  })
  .refine((data) => data.mode !== "single" || (data.providerSlug && data.modelId), {
    message: "providerSlug and modelId are required for single mode",
  });

export async function updateConversation(req: Request, res: Response) {
  const { mode, providerSlug, modelId } = updateConversationSchema.parse(req.body);
  const conversation = await chatService.updateConversationModel(
    req.user!.id,
    req.params.id,
    mode,
    providerSlug,
    modelId,
  );
  res.json({ conversation });
}

export async function listConversations(req: Request, res: Response) {
  const { projectId, ...page } = listConversationsQuerySchema.parse(req.query);
  res.json({ conversations: await chatService.listConversations(req.user!.id, page, projectId) });
}

export async function deleteAllConversations(req: Request, res: Response) {
  await chatService.deleteAllConversations(req.user!.id);
  res.status(204).send();
}

export async function deleteConversation(req: Request, res: Response) {
  await chatService.deleteConversation(req.user!.id, req.params.id);
  res.status(204).send();
}

export async function listMessages(req: Request, res: Response) {
  const page = pageSchema.parse(req.query);
  res.json({ messages: await chatService.listMessages(req.user!.id, req.params.id, page) });
}

const attachmentSchema = z.object({
  mime: z.string().min(1),
  dataUrl: z.string().min(1),
  name: z.string().trim().min(1).max(255).optional(),
  size: z.number().int().min(0).optional(),
  kind: z.enum(["image", "file"]).optional(),
});

const sendMessageSchema = z
  .object({
    content: z.string().trim().max(50_000),
    inputMode: z.enum(["text", "voice"]).optional().default("text"),
    think: z.boolean().optional().default(false),
    behavior: z.string().trim().max(1000).optional().default(""),
    webSearch: z.boolean().optional().default(false),
    canvas: z.boolean().optional().default(false),
    research: z.boolean().optional().default(false),
    // A skill the user picked in the composer (built-in id or "u_<uuid>") — pinned into the turn.
    skillId: z.string().trim().max(80).optional(),
    // Build workspace's effort picker: how hard the Build agent works (rounds + verification).
    effort: z.enum(["low", "medium", "high"]).optional(),
    // Build workspace permission mode (projectBuild/approvals.ts).
    permissionMode: z.enum(["ask", "auto_edit", "full_auto"]).optional(),
    // Repo + branch picked in the Build composer, sent as fields (not rewritten into the message text)
    // so the sandbox can clone it before the agent's first turn.
    repo: z
      .object({
        repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/).max(140),
        branch: z.string().trim().min(1).max(200).optional(),
      })
      .optional(),
    attachments: z.array(attachmentSchema).max(4).optional().default([]),
  })
  // The composer already allows sending an attachment with no caption text (an image with
  // nothing typed is a completely normal thing to send) — this used to require non-empty
  // content unconditionally, so that exact case landed a raw Zod error on the user's screen
  // instead of an image-only message. Empty is fine as long as something was attached.
  .refine((data) => data.content.length > 0 || data.attachments.length > 0, {
    message: "Message cannot be empty",
    path: ["content"],
  });

export async function streamMessage(req: Request, res: Response) {
  const { registerPresence } = await import("../services/phone/store.js");
  if (req.user) registerPresence(req.user.id, "web");
  const { content, inputMode, think, behavior, webSearch, canvas, research, skillId, effort, permissionMode, repo, attachments } = sendMessageSchema.parse(req.body);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Reverse proxies (nginx-style edges, Railway's included) may buffer a response body until a
  // size threshold — tokens then arrive in delayed bursts ("sticks, then dumps a paragraph") no
  // matter how evenly the model streams. This header opts the stream out of proxy buffering.
  res.setHeader("X-Accel-Buffering", "no");
  // Every token is a tiny write; Nagle's algorithm would hold them back to coalesce packets.
  res.socket?.setNoDelay(true);
  res.flushHeaders?.();

  // Generation is decoupled from the connection: closing the tab / killing the app only drops
  // this socket, the reply still finishes and is persisted (other devices pick it up via
  // realtime, and a push notification goes out below). Only an explicit Stop cancels it.
  // Immediate first frame: the client can show its "thinking" state the instant the stream opens instead
  // of waiting for the server to finish its pre-model work.
  res.write(`data: ${JSON.stringify({ t: "status", s: "thinking" })}\n\n`);

  let clientGone = false;
  req.on("close", () => {
    clientGone = true;
  });
  const send = (event: chatService.StreamEvent) => {
    if (clientGone || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Team Up and Think mode can go silent for well over a minute while a reasoning model works —
  // no bytes on the wire in that window looks identical, to Railway's edge/Cloudflare, to a dead
  // connection, and either can close it. An SSE comment line (ignored by the client's parser,
  // which only reads `data:` lines) keeps the connection visibly alive without affecting events.
  const heartbeat = setInterval(() => {
    if (!clientGone && !res.writableEnded) res.write(": ping\n\n");
  }, 15_000);

  try {
    // The turn runs to completion whether or not this connection survives (jobs/runTurn.ts): it is
    // registered as running for every instance, logged for live replay on any device, resumed after
    // a restart (Build) and followed by a push notification when nobody was watching at the end.
    await runTurn({
      userId: req.user!.id,
      conversationId: req.params.id!,
      kind: research ? "research" : "chat",
      request: {
        content,
        inputMode,
        think,
        behavior,
        webSearch,
        canvas,
        options: { research, skillId, effort, permissionMode, repo },
        hadAttachments: attachments.length > 0,
      },
      attachments,
      reservation: req.quotaReservation,
      onEvent: send,
      listening: () => !clientGone,
    });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}

/** Replays the current (or last) turn's events and says whether it's still running — any device can follow along. */
export async function live(req: Request, res: Response) {
  await getOwnedConversation(req.user!.id, req.params.id!);
  const { after } = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  res.json(await readEvents(req.params.id!, after));
}

export async function stopMessage(req: Request, res: Response) {
  stopGeneration(req.params.id!, req.user!.id);
  // The turn may be running on another instance — its heartbeat sees this flag and stops it.
  await requestStop(req.params.id!, req.user!.id).catch(() => undefined);
  res.status(204).end();
}

export async function search(req: Request, res: Response) {
  const { q } = z.object({ q: z.string().max(200).default("") }).parse(req.query);
  res.json({ results: await searchAndShare.searchMessages(req.user!.id, q) });
}

export async function share(req: Request, res: Response) {
  res.json(await searchAndShare.shareConversation(req.user!.id, req.params.id));
}

export async function unshare(req: Request, res: Response) {
  await searchAndShare.unshareConversation(req.user!.id, req.params.id);
  res.status(204).end();
}

export async function getShared(req: Request, res: Response) {
  res.setHeader("Cache-Control", "private, max-age=60");
  res.json(await searchAndShare.getSharedConversation(req.params.token));
}
