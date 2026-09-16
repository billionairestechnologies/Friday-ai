import type { Request, Response } from "express";
import { z } from "zod";
import * as chatService from "../services/chatService.js";

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
  res.json({ conversations: await chatService.listConversations(req.user!.id) });
}

export async function deleteConversation(req: Request, res: Response) {
  await chatService.deleteConversation(req.user!.id, req.params.id);
  res.status(204).send();
}

export async function listMessages(req: Request, res: Response) {
  res.json({ messages: await chatService.listMessages(req.user!.id, req.params.id) });
}

const sendMessageSchema = z.object({
  content: z.string().trim().min(1, "Message cannot be empty"),
  inputMode: z.enum(["text", "voice"]).optional().default("text"),
  think: z.boolean().optional().default(false),
  behavior: z.string().trim().max(1000).optional().default(""),
  webSearch: z.boolean().optional().default(false),
});

export async function sendMessage(req: Request, res: Response) {
  const { content, inputMode, think, behavior, webSearch } = sendMessageSchema.parse(req.body);
  const replies = await chatService.sendMessage(
    req.user!.id,
    req.params.id,
    content,
    inputMode,
    think,
    behavior,
    webSearch,
  );
  res.status(201).json({ messages: replies });
}

export async function streamMessage(req: Request, res: Response) {
  const { content, inputMode, think, behavior, webSearch } = sendMessageSchema.parse(req.body);

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
