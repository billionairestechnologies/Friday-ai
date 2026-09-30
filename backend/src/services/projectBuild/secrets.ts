import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { decryptSecret, encryptSecret } from "../../utils/crypto.js";

/**
 * Per-project secrets vault (build_secrets). Values are encrypted at rest, injected into the sandbox
 * as environment variables for the project's commands and dev server, and never shown to the model:
 * the agent only learns the NAMES, and every piece of command output is passed through redact()
 * before the model or the user sees it.
 */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_SECRETS = 50;

export async function listSecretNames(conversationId: string): Promise<{ name: string; updatedAt: string }[]> {
  const { data, error } = await supabaseAdmin
    .from("build_secrets")
    .select("name, updated_at")
    .eq("conversation_id", conversationId)
    .order("name");
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).map((r) => ({ name: r.name as string, updatedAt: r.updated_at as string }));
}

export async function setSecret(conversationId: string, name: string, value: string): Promise<void> {
  if (!SECRET_NAME.test(name)) throw new HttpError(400, "Use UPPER_CASE letters, digits and _ (e.g. STRIPE_SECRET_KEY).");
  const existing = await listSecretNames(conversationId);
  if (!existing.some((s) => s.name === name) && existing.length >= MAX_SECRETS) throw new HttpError(400, `Up to ${MAX_SECRETS} secrets per project.`);
  const { error } = await supabaseAdmin
    .from("build_secrets")
    .upsert({ conversation_id: conversationId, name, value_encrypted: encryptSecret(value), updated_at: new Date().toISOString() });
  if (error) throw new HttpError(500, error.message);
}

export async function deleteSecret(conversationId: string, name: string): Promise<void> {
  const { error } = await supabaseAdmin.from("build_secrets").delete().eq("conversation_id", conversationId).eq("name", name);
  if (error) throw new HttpError(500, error.message);
}

/** name → plain value, for injecting into the sandbox. Unreadable rows are skipped, not fatal. */
export async function loadSecrets(conversationId: string): Promise<Record<string, string>> {
  const { data } = await supabaseAdmin.from("build_secrets").select("name, value_encrypted").eq("conversation_id", conversationId);
  const out: Record<string, string> = {};
  for (const row of data ?? []) {
    try {
      out[row.name as string] = decryptSecret(row.value_encrypted as string);
    } catch {
      /* key rotated / corrupt — leave it out rather than break the build */
    }
  }
  return out;
}

/** Replaces every secret value (4+ chars) in text with [secret NAME]. */
export function redactSecrets(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length < 4) continue;
    out = out.split(value).join(`[secret ${name}]`);
  }
  return out;
}
