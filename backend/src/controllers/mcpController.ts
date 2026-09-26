import type { Request, Response } from "express";
import { z } from "zod";
import * as mcp from "../services/agent/mcpService.js";

const idParam = z.object({ id: z.string().uuid() });

export async function list(req: Request, res: Response) {
  res.json({ servers: await mcp.listMcpServers(req.user!.id) });
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await mcp.addMcpServer(req.user!.id, mcp.mcpServerInputSchema.parse(req.body)));
}

export async function update(req: Request, res: Response) {
  const { id } = idParam.parse(req.params);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  res.json({ server: await mcp.setMcpServerEnabled(req.user!.id, id, enabled) });
}

export async function remove(req: Request, res: Response) {
  const { id } = idParam.parse(req.params);
  await mcp.deleteMcpServer(req.user!.id, id);
  res.status(204).end();
}

export async function tools(req: Request, res: Response) {
  const { id } = idParam.parse(req.params);
  const list = await mcp.listServerTools(req.user!.id, id);
  res.json({ tools: list.map((t) => ({ name: t.name, description: t.description ?? "" })) });
}
