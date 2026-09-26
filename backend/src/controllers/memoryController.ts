import type { Request, Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler.js";
import * as memory from "../services/memoryService.js";

export async function list(req: Request, res: Response) {
  res.json({ memories: await memory.listMemories(req.user!.id) });
}

export async function create(req: Request, res: Response) {
  const { content } = z.object({ content: z.string().min(1).max(memory.MAX_MEMORY_CHARS) }).parse(req.body);
  res.status(201).json({ memory: await memory.addMemory(req.user!.id, content) });
}

export async function remove(req: Request, res: Response) {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  if (!(await memory.deleteMemory(req.user!.id, id))) throw new HttpError(404, "Memory not found");
  res.status(204).end();
}

export async function clear(req: Request, res: Response) {
  await memory.clearMemories(req.user!.id);
  res.status(204).end();
}
