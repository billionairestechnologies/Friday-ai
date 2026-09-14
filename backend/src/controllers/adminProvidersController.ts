import type { Request, Response } from "express";
import { z } from "zod";
import * as providerService from "../services/providerService.js";

export async function listProviders(_req: Request, res: Response) {
  res.json({ providers: await providerService.listProvidersWithStatus() });
}

const addKeySchema = z.object({
  label: z.string().trim().max(120).optional().default("default"),
  apiKey: z.string().trim().min(1, "API key is required"),
});

export async function addKey(req: Request, res: Response) {
  const { slug } = req.params;
  const { label, apiKey } = addKeySchema.parse(req.body);
  const result = await providerService.addApiKey(slug, label, apiKey, req.user!.id);
  res.status(201).json(result);
}

export async function deleteKey(req: Request, res: Response) {
  await providerService.deleteApiKey(req.params.keyId);
  res.status(204).send();
}

export async function checkKey(req: Request, res: Response) {
  const health = await providerService.checkApiKeyHealth(req.params.keyId);
  res.json({ health });
}

export async function checkAllKeys(_req: Request, res: Response) {
  res.json({ results: await providerService.checkAllApiKeysHealth() });
}

export async function syncModels(req: Request, res: Response) {
  const count = await providerService.syncProviderModels(req.params.slug);
  res.json({ discoveredModels: count });
}

export async function listProviderModels(req: Request, res: Response) {
  res.json({ models: await providerService.listModelsForProvider(req.params.slug) });
}

const setEnabledSchema = z.object({ enabled: z.boolean() });

export async function setModelEnabled(req: Request, res: Response) {
  const { enabled } = setEnabledSchema.parse(req.body);
  await providerService.setModelEnabled(req.params.modelId, enabled);
  res.status(204).send();
}
