import type { Request, Response } from "express";
import { z } from "zod";
import * as chatService from "../services/chat/index.js";

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().datetime().optional(),
});

const createConversationSchema = z
  .object({
    mode: z.enum(["single", "auto", "teamup"]).optional().default("single"),
    providerSlug: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    title: z.string().trim().max(200).optional(),
  })
  .refine((data) => data.mode !== "single" || (data.providerSlug && data.modelId), {
    message: "providerSlug and modelId are required for single mode",
  });

export async function createConversation(req: Request, res: Response) {
  const { mode, providerSlug, modelId, title } = createConversationSchema.parse(req.body);
  const conversation = await chatService.createConversation(req.user!.id, mode, providerSlug, modelId, title);
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
  const page = pageSchema.parse(req.query);
  res.json({ conversations: await chatService.listConversations(req.user!.id, page) });
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
  const { content, inputMode, think, behavior, webSearch, canvas, attachments } = sendMessageSchema.parse(req.body);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  const send = (event: chatService.StreamEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Team Up and Think mode can go silent for well over a minute while a reasoning model works —
  // no bytes on the wire in that window looks identical, to Railway's edge/Cloudflare, to a dead
  // connection, and either can close it. An SSE comment line (ignored by the client's parser,
  // which only reads `data:` lines) keeps the connection visibly alive without affecting events.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  try {
    await chatService.streamMessage(
      req.user!.id,
      req.params.id,
      content,
      inputMode,
      send,
      abortController.signal,
      think,
      behavior,
      webSearch,
      canvas,
      attachments,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong";
    send({ t: "err", c: message });
    send({ t: "done" });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}
