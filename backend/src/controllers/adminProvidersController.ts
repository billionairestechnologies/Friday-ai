import type { Request, Response } from "express";
import { z } from "zod";
import * as providerService from "../services/providerService.js";
import { recordAdminAuditLog } from "../services/usageService.js";

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
  void recordAdminAuditLog(req.user!.id, "provider_key_added", "provider", slug, { label });
  res.status(201).json(result);
}

export async function deleteKey(req: Request, res: Response) {
  await providerService.deleteApiKey(req.params.keyId);
  void recordAdminAuditLog(req.user!.id, "provider_key_deleted", "provider_api_key", req.params.keyId);
  res.status(204).send();
}

export async function checkKey(req: Request, res: Response) {
  const health = await providerService.checkApiKeyHealth(req.params.keyId);
  void recordAdminAuditLog(req.user!.id, "provider_key_checked", "provider_api_key", req.params.keyId, {
    ok: health.ok,
  });
  res.json({ health });
}

export async function checkAllKeys(req: Request, res: Response) {
  const results = await providerService.checkAllApiKeysHealth();
  void recordAdminAuditLog(req.user!.id, "provider_keys_checked", "provider_api_key", undefined, {
    count: results.length,
  });
  res.json({ results });
}

export async function syncModels(req: Request, res: Response) {
  const count = await providerService.syncProviderModels(req.params.slug);
  void recordAdminAuditLog(req.user!.id, "provider_models_synced", "provider", req.params.slug, { count });
  res.json({ discoveredModels: count });
}

export async function listProviderModels(req: Request, res: Response) {
  res.json({ models: await providerService.listModelsForProvider(req.params.slug) });
}

const setEnabledSchema = z.object({ enabled: z.boolean() });

export async function setModelEnabled(req: Request, res: Response) {
  const { enabled } = setEnabledSchema.parse(req.body);
  await providerService.setModelEnabled(req.params.modelId, enabled);
  void recordAdminAuditLog(req.user!.id, "provider_model_visibility_changed", "provider_model", req.params.modelId, {
    enabled,
  });
  res.status(204).send();
}
