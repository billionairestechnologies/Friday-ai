import { supabaseAdmin } from "../config/supabase.js";
import { decryptSecret, encryptSecret, maskSecret } from "../utils/crypto.js";
import { HttpError } from "../middleware/errorHandler.js";
import { getProviderAdapter } from "./providers/registry.js";

async function getProviderBySlug(slug: string) {
  const { data, error } = await supabaseAdmin.from("providers").select("*").eq("slug", slug).single();
  if (error || !data) throw new HttpError(404, `Unknown provider: ${slug}`);
  return data;
}

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

export async function addApiKey(slug: string, label: string, plainKey: string, createdBy: string) {
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

export async function deleteApiKey(keyId: string) {
  const { error } = await supabaseAdmin.from("provider_api_keys").delete().eq("id", keyId);
  if (error) throw new HttpError(500, error.message);
}

export async function checkApiKeyHealth(keyId: string) {
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
export async function checkAllApiKeysHealth() {
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
export async function discoverModels(slug: string, plainKey: string): Promise<number> {
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
export async function syncProviderModels(slug: string): Promise<number> {
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

export async function setModelEnabled(modelId: string, enabled: boolean) {
  const { error } = await supabaseAdmin
    .from("provider_models")
    .update({ is_enabled_for_users: enabled })
    .eq("id", modelId);
  if (error) throw new HttpError(500, error.message);
}

/** Models shown in the chat/auth-page model selector — only ones the admin has enabled. */
export async function listModelsForUsers() {
  const { data, error } = await supabaseAdmin
    .from("provider_models")
    .select("id, model_id, display_name, capabilities, providers(slug, display_name)")
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
}

/** Looks up a single model's friendly display name (e.g. "Sarvam 105B") for reply labels. Falls back to the raw model id. */
export async function getModelDisplayName(providerId: string, modelId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("provider_models")
    .select("display_name")
    .eq("provider_id", providerId)
    .eq("model_id", modelId)
    .maybeSingle();
  return data?.display_name ?? modelId;
}

/**
 * Enabled, chat-capable models whose provider currently has a working key —
 * the pool that Auto and Team Up modes pick from.
 */
export async function listChatCandidates(): Promise<ChatCandidate[]> {
  const { data: models, error } = await supabaseAdmin
    .from("provider_models")
    .select("model_id, display_name, capabilities, provider_id, providers(slug, display_name)")
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
      return { slug: provider.slug, providerDisplayName: provider.display_name, modelId: m.model_id, displayName: m.display_name };
    });
}

/** Returns a decrypted, working API key for the given provider — used by the chat/voice services. */
export async function getWorkingKeyForProvider(slug: string): Promise<string> {
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
}
