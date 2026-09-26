import type { Request, Response } from "express";
import { z } from "zod";
import * as automations from "../services/automations/automationService.js";

const idParam = z.object({ id: z.string().uuid() });

export async function list(req: Request, res: Response) {
  res.json({ automations: await automations.listAutomations(req.user!.id) });
}

export async function create(req: Request, res: Response) {
  const input = automations.automationInputSchema.parse(req.body);
  res.status(201).json({ automation: await automations.createAutomation(req.user!.id, input) });
}

export async function update(req: Request, res: Response) {
  const { id } = idParam.parse(req.params);
  const patch = automations.automationInputSchema.partial().parse(req.body);
  res.json({ automation: await automations.updateAutomation(req.user!.id, id, patch) });
}

export async function remove(req: Request, res: Response) {
  const { id } = idParam.parse(req.params);
  await automations.deleteAutomation(req.user!.id, id);
  res.status(204).end();
}

export async function runNow(req: Request, res: Response) {
  const { id } = idParam.parse(req.params);
  await automations.runAutomationNow(req.user!.id, id);
  res.status(202).json({ ok: true });
}
