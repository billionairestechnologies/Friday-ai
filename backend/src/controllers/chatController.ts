import type { Request, Response } from "express";
import { z } from "zod";
import * as chatService from "../services/chatService.js";

const createConversationSchema = z.object({
  providerSlug: z.string().min(1),
  modelId: z.string().min(1),
  title: z.string().trim().max(200).optional(),
});

export async function createConversation(req: Request, res: Response) {
  const { providerSlug, modelId, title } = createConversationSchema.parse(req.body);
  const conversation = await chatService.createConversation(req.user!.id, providerSlug, modelId, title);
  res.status(201).json({ conversation });
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
});

export async function sendMessage(req: Request, res: Response) {
  const { content, inputMode } = sendMessageSchema.parse(req.body);
  const reply = await chatService.sendMessage(req.user!.id, req.params.id, content, inputMode);
  res.status(201).json({ message: reply });
}
