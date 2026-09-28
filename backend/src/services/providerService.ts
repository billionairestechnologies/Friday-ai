import { supabaseAdmin } from "../config/supabase.js";
import { decryptSecret, encryptSecret, maskSecret } from "../utils/crypto.js";
import { HttpError } from "../middleware/errorHandler.js";
import { getProviderAdapter } from "./providers/registry.js";
import { invalidateMemoized, memoAsync } from "../utils/ttlMemo.js";

const LOOKUP_TTL_MS = 45_000;

const getProviderBySlug = memoAsync(LOOKUP_TTL_MS, async (slug: string) => {
  const { data, error } = await supabaseAdmin.from("providers").select("*").eq("slug", slug).single();
  if (error || !data) throw new HttpError(404, `Unknown provider: ${slug}`);
  return data;
});

export async function listProvidersWithStatus() {
  const { data: providers, error } = await supabaseAdmin.from("providers").select("*").order("display_name");
  if (error) throw new HttpError(500, error.message);

  const { data: keys } = await supabaseAdmin
    .from("provider_api_keys")
    .select("id, provider_id, label, masked_preview, is_active, is_working, last_checked_at, last_error, created_at");

  const { data: models } = await supabaseAdmin
    .from("provider_models")
    .select("id, provider_id, is_enabled_for_users");

  return providers.map((p) => ({
    ...p,
    keys: (keys ?? []).filter((k) => k.provider_id === p.id),
    modelCount: (models ?? []).filter((m) => m.provider_id === p.id).length,
    enabledModelCount: (models ?? []).filter((m) => m.provider_id === p.id && m.is_enabled_for_users).length,
  }));
}

async function addApiKeyImpl(slug: string, label: string, plainKey: string, createdBy: string) {
  const provider = await getProviderBySlug(slug);
  const adapter = getProviderAdapter(slug);

  const { data: keyRow, error } = await supabaseAdmin
    .from("provider_api_keys")
    .insert({
      provider_id: provider.id,
      label: label || "default",
      encrypted_key: encryptSecret(plainKey),
      masked_preview: maskSecret(plainKey),
      created_by: createdBy,
    })
    .select()
    .single();
  if (error || !keyRow) throw new HttpError(500, error?.message ?? "Failed to save API key");

  // Immediately verify the key and pull in whatever models it can see.
  const health = await adapter.healthCheck(plainKey);
  await supabaseAdmin
    .from("provider_api_keys")
    .update({ is_working: health.ok, last_checked_at: new Date().toISOString(), last_error: health.error ?? null })
    .eq("id", keyRow.id);

  let discovered = 0;
  if (health.ok) {
    discovered = await discoverModels(slug, plainKey);
  }

  return { key: { ...keyRow, is_working: health.ok }, health, discoveredModels: discovered };
}

async function deleteApiKeyImpl(keyId: string) {
  const { error } = await supabaseAdmin.from("provider_api_keys").delete().eq("id", keyId);
  if (error) throw new HttpError(500, error.message);
}

async function checkApiKeyHealthImpl(keyId: string) {
  const { data: keyRow, error } = await supabaseAdmin
    .from("provider_api_keys")
    .select("*, providers(slug)")
    .eq("id", keyId)
    .single();
  if (error || !keyRow) throw new HttpError(404, "API key not found");

  const slug = (keyRow as unknown as { providers: { slug: string } }).providers.slug;
  const adapter = getProviderAdapter(slug);
  const plainKey = decryptSecret(keyRow.encrypted_key);
  const health = await adapter.healthCheck(plainKey);

  await supabaseAdmin
    .from("provider_api_keys")
    .update({ is_working: health.ok, last_checked_at: new Date().toISOString(), last_error: health.error ?? null })
    .eq("id", keyId);

  return health;
}

/** Runs health checks for every stored key; called by the admin "Check all" button and can be cron'd. */
async function checkAllApiKeysHealthImpl() {
  const { data: keys, error } = await supabaseAdmin.from("provider_api_keys").select("id");
  if (error) throw new HttpError(500, error.message);
  const results = await Promise.allSettled((keys ?? []).map((k) => checkApiKeyHealth(k.id)));
  return results.map((r, i) => ({
    keyId: keys![i].id,
    ok: r.status === "fulfilled" ? r.value.ok : false,
    error: r.status === "rejected" ? String(r.reason) : r.status === "fulfilled" ? r.value.error : undefined,
  }));
}

/** Fetches the provider's live model list with a working key and upserts them into provider_models. */
async function discoverModelsImpl(slug: string, plainKey: string): Promise<number> {
  const provider = await getProviderBySlug(slug);
  const adapter = getProviderAdapter(slug);
  const models = await adapter.listModels(plainKey);

  if (models.length === 0) return 0;

  const { error } = await supabaseAdmin.from("provider_models").upsert(
    models.map((m) => ({
      provider_id: provider.id,
      model_id: m.modelId,
      display_name: m.displayName,
      capabilities: m.capabilities,
    })),
    { onConflict: "provider_id,model_id", ignoreDuplicates: false },
  );
  if (error) throw new HttpError(500, error.message);
  return models.length;
}

/** Re-runs discovery using whichever active key for this provider currently works. */
async function syncProviderModelsImpl(slug: string): Promise<number> {
  const provider = await getProviderBySlug(slug);
  const { data: keyRow } = await supabaseAdmin
    .from("provider_api_keys")
    .select("*")
    .eq("provider_id", provider.id)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!keyRow) throw new HttpError(400, "No active API key for this provider");
  const plainKey = decryptSecret(keyRow.encrypted_key);
  return discoverModels(slug, plainKey);
}

export async function listModelsForProvider(slug: string) {
  const provider = await getProviderBySlug(slug);
  const { data, error } = await supabaseAdmin
    .from("provider_models")
    .select("*")
    .eq("provider_id", provider.id)
    .order("display_name");
  if (error) throw new HttpError(500, error.message);
  return data;
}

async function setModelEnabledImpl(modelId: string, enabled: boolean) {
  const { error } = await supabaseAdmin
    .from("provider_models")
    .update({ is_enabled_for_users: enabled })
    .eq("id", modelId);
  if (error) throw new HttpError(500, error.message);
}

/** Which plan tier a model is gated behind (see chat/index.ts's tier gate and canUseModelTier). */
async function setModelMinTierImpl(modelId: string, minTier: "free" | "pro" | "premium") {
  const { error } = await supabaseAdmin.from("provider_models").update({ min_tier: minTier }).eq("id", modelId);
  if (error) throw new HttpError(500, error.message);
}

/** Models shown in the chat/auth-page model selector — only ones the admin has enabled. */
export async function listModelsForUsers() {
  const { data, error } = await supabaseAdmin
    .from("provider_models")
    .select("id, model_id, display_name, capabilities, min_tier, providers(slug, display_name)")
    .eq("is_enabled_for_users", true)
    .order("display_name");
  if (error) throw new HttpError(500, error.message);
  return data;
}

export interface ChatCandidate {
  slug: string;
  providerDisplayName: string;
  modelId: string;
  displayName: string;
  vision: boolean;
  minTier: "free" | "pro" | "premium";
  /** Admin-set capabilities.coding flag — true/false when an admin has explicitly tagged the
   *  model, undefined when nobody has (see isBuildWorthy, which then falls back to a name heuristic). */
  coding?: boolean;
}

// Cheap/small chat-tier models that shouldn't drive Build Mode (a real coding agent loop needs a
// frontier/coding-strong model, not the lightest, cheapest chat model) — a denylist rather than an
// allowlist so unfamiliar-but-capable model names aren't accidentally excluded.
const LIGHTWEIGHT_MODEL_PATTERN = /\b(mini|nano|lite|flash-8b|flash-lite|haiku|small(?!-\d{2,})|tiny|instant)\b/i;

/** Whether a model should be offered to Build Mode: an admin's explicit capabilities.coding flag
 *  wins, otherwise anything not matching the lightweight/chat-tier denylist above is assumed capable. */
export function isBuildWorthy(candidate: ChatCandidate): boolean {
  if (candidate.coding === true) return true;
  if (candidate.coding === false) return false;
  const label = `${candidate.modelId} ${candidate.displayName}`;
  return !LIGHTWEIGHT_MODEL_PATTERN.test(label);
}

/** Looks up a single model's friendly display name (e.g. "Sarvam 105B") for reply labels. Falls back to the raw model id. */
export const getModelDisplayName = memoAsync(LOOKUP_TTL_MS, async (providerId: string, modelId: string): Promise<string> => {
  const { data } = await supabaseAdmin
    .from("provider_models")
    .select("display_name")
    .eq("provider_id", providerId)
    .eq("model_id", modelId)
    .maybeSingle();
  return data?.display_name ?? modelId;
});

/** Whether a single specific model supports image input — used to gate attachments in single mode. */
export const getModelVisionSupport = memoAsync(LOOKUP_TTL_MS, async (providerId: string, modelId: string): Promise<boolean> => {
  const { data } = await supabaseAdmin
    .from("provider_models")
    .select("capabilities")
    .eq("provider_id", providerId)
    .eq("model_id", modelId)
    .maybeSingle();
  return (data?.capabilities as Record<string, boolean> | null)?.vision === true;
});

/** The plan tier (free/pro/premium) an admin has gated this model behind — used to keep a Free
 *  user off flagship/reasoning models even in single mode, where they picked the model directly. */
export const getModelMinTier = memoAsync(LOOKUP_TTL_MS, async (providerId: string, modelId: string): Promise<"free" | "pro" | "premium"> => {
  const { data } = await supabaseAdmin
    .from("provider_models")
    .select("min_tier")
    .eq("provider_id", providerId)
    .eq("model_id", modelId)
    .maybeSingle();
  return (data?.min_tier as "free" | "pro" | "premium" | undefined) ?? "free";
});

/**
 * Enabled, chat-capable models whose provider currently has a working key —
 * the pool that Auto and Team Up modes pick from.
 */
export const listChatCandidates = memoAsync(30_000, async (): Promise<ChatCandidate[]> => {
  const { data: models, error } = await supabaseAdmin
    .from("provider_models")
    .select("model_id, display_name, capabilities, provider_id, min_tier, providers(slug, display_name)")
    .eq("is_enabled_for_users", true);
  if (error) throw new HttpError(500, error.message);

  const { data: keys } = await supabaseAdmin
    .from("provider_api_keys")
    .select("provider_id, is_active, is_working");

  const workingProviderIds = new Set(
    (keys ?? []).filter((k) => k.is_active && k.is_working).map((k) => k.provider_id),
  );

  return (models ?? [])
    .filter((m) => workingProviderIds.has(m.provider_id))
    .filter((m) => (m.capabilities as Record<string, boolean> | null)?.chat === true)
    .map((m) => {
      const provider = (m as unknown as { providers: { slug: string; display_name: string } }).providers;
      const capabilities = m.capabilities as Record<string, boolean> | null;
      return {
        slug: provider.slug,
        providerDisplayName: provider.display_name,
        modelId: m.model_id,
        displayName: m.display_name,
        vision: capabilities?.vision === true,
        minTier: (m.min_tier as "free" | "pro" | "premium" | null) ?? "free",
        coding: typeof capabilities?.coding === "boolean" ? capabilities.coding : undefined,
      };
    });
});

/** Returns a decrypted, working API key for the given provider — used by the chat/voice services. */
export const getWorkingKeyForProvider = memoAsync(LOOKUP_TTL_MS, async (slug: string): Promise<string> => {
  const provider = await getProviderBySlug(slug);
  const { data: keyRow, error } = await supabaseAdmin
    .from("provider_api_keys")
    .select("*")
    .eq("provider_id", provider.id)
    .eq("is_active", true)
    .eq("is_working", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !keyRow) throw new HttpError(503, `No working API key configured for ${slug}`);
  return decryptSecret(keyRow.encrypted_key);
});

/** Admin mutation — drops memoized provider/key/model lookups so the change takes effect immediately. */
export async function addApiKey(...args: Parameters<typeof addApiKeyImpl>): ReturnType<typeof addApiKeyImpl> {
  try {
    return await addApiKeyImpl(...args);
  } finally {
    invalidateMemoized();
  }
}

/** Admin mutation — drops memoized provider/key/model lookups so the change takes effect immediately. */
export async function deleteApiKey(...args: Parameters<typeof deleteApiKeyImpl>): ReturnType<typeof deleteApiKeyImpl> {
  try {
    return await deleteApiKeyImpl(...args);
  } finally {
    invalidateMemoized();
  }
}

/** Admin mutation — drops memoized provider/key/model lookups so the change takes effect immediately. */
export async function checkApiKeyHealth(...args: Parameters<typeof checkApiKeyHealthImpl>): ReturnType<typeof checkApiKeyHealthImpl> {
  try {
    return await checkApiKeyHealthImpl(...args);
  } finally {
    invalidateMemoized();
  }
}

/** Admin mutation — drops memoized provider/key/model lookups so the change takes effect immediately. */
export async function checkAllApiKeysHealth(...args: Parameters<typeof checkAllApiKeysHealthImpl>): ReturnType<typeof checkAllApiKeysHealthImpl> {
  try {
    return await checkAllApiKeysHealthImpl(...args);
  } finally {
    invalidateMemoized();
  }
}

/** Admin mutation — drops memoized provider/key/model lookups so the change takes effect immediately. */
export async function discoverModels(...args: Parameters<typeof discoverModelsImpl>): ReturnType<typeof discoverModelsImpl> {
  try {
    return await discoverModelsImpl(...args);
  } finally {
    invalidateMemoized();
  }
}

/** Admin mutation — drops memoized provider/key/model lookups so the change takes effect immediately. */
export async function syncProviderModels(...args: Parameters<typeof syncProviderModelsImpl>): ReturnType<typeof syncProviderModelsImpl> {
  try {
    return await syncProviderModelsImpl(...args);
  } finally {
    invalidateMemoized();
  }
}

/** Admin mutation — drops memoized provider/key/model lookups so the change takes effect immediately. */
export async function setModelEnabled(...args: Parameters<typeof setModelEnabledImpl>): ReturnType<typeof setModelEnabledImpl> {
  try {
    return await setModelEnabledImpl(...args);
  } finally {
    invalidateMemoized();
  }
}

/** Admin mutation — drops memoized provider/key/model lookups so the change takes effect immediately. */
export async function setModelMinTier(...args: Parameters<typeof setModelMinTierImpl>): ReturnType<typeof setModelMinTierImpl> {
  try {
    return await setModelMinTierImpl(...args);
  } finally {
    invalidateMemoized();
  }
}
