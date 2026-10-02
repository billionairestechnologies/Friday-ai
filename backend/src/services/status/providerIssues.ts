import { supabaseAdmin } from "../../config/supabase.js";
import { classifyProviderIssue, type ProviderIssueKind } from "../../utils/providerError.js";
import { logger } from "../../utils/logger.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { alertTeam } from "./statusService.js";

// Users only ever see "we're facing high usage…"; the real reason (out of credit, gateway down, key
// rejected) is kept here, grouped per provider + kind, and the team is emailed so it gets fixed fast.
// Re-alerts while an issue keeps happening, but at most once per cooldown.
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const PROVIDERS = ["scalemax", "openai", "anthropic", "gemini", "openrouter", "sarvam", "ollama", "elevenlabs", "e2b", "tavily", "tinyfish", "resend", "razorpay"];

/** Pulls a provider name out of "<slug>: <Provider> chat failed…" or any text naming one. */
export function providerFrom(raw: string, hint?: string): string {
  if (hint) return hint.toLowerCase();
  const prefix = /^([a-z0-9_-]{2,24}):\s/i.exec(raw.trim())?.[1]?.toLowerCase();
  if (prefix && PROVIDERS.includes(prefix)) return prefix;
  const named = PROVIDERS.find((p) => new RegExp(`\\b${p}\\b`, "i").test(raw));
  return named ?? prefix ?? "unknown";
}

/** Keys, bearer tokens and JWTs must never land in an admin table or an email. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|rk|pk|re|tvly|sm_live)[-_][A-Za-z0-9_-]{8,}/g, "$1-…")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[jwt]")
    .replace(/(bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1…")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi, "$1…");
}

const KIND_TEXT: Record<ProviderIssueKind, string> = {
  quota: "ran out of credit / quota — top up or renew the plan",
  gateway: "is returning gateway / timeout errors",
  rate_limit: "is rate-limiting Friday",
  auth: "rejected Friday's API key",
  too_large: "rejected a request as too large",
  other: "returned an error",
};

export async function recordProviderIssue(input: { raw: string; provider?: string; userId?: string | null; conversationId?: string | null }): Promise<void> {
  try {
    const kind = classifyProviderIssue(input.raw);
    const provider = providerFrom(input.raw, input.provider);
    const sample = redactSecrets(input.raw).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
    const now = new Date();

    const { data: open } = await supabaseAdmin.from("provider_issues").select("id, occurrences, alerted_at").eq("provider", provider).eq("kind", kind).is("resolved_at", null).maybeSingle();
    let id = open?.id as string | undefined;
    let alertedAt = (open?.alerted_at as string | null | undefined) ?? null;
    if (open) {
      await supabaseAdmin.from("provider_issues").update({ occurrences: Number(open.occurrences) + 1, last_seen: now.toISOString(), sample }).eq("id", open.id);
    } else {
      const { data, error } = await supabaseAdmin.from("provider_issues").insert({ provider, kind, sample }).select("id").single();
      if (error) {
        // Two failures racing to open the same issue: the unique index rejected one — count it on the winner instead.
        if (error.code === "23505") return void recordProviderIssue(input);
        throw error;
      }
      id = data.id as string;
    }

    const due = !alertedAt || now.getTime() - new Date(alertedAt).getTime() > ALERT_COOLDOWN_MS;
    if (id && due) {
      await supabaseAdmin.from("provider_issues").update({ alerted_at: now.toISOString() }).eq("id", id);
      void alertTeam(
        `Provider issue: ${provider} ${KIND_TEXT[kind]}`,
        `**Provider:** ${provider}\n\n**What happened:** ${provider} ${KIND_TEXT[kind]}.\n\n**Users saw:** a friendly "high usage, try again or switch models" message (no provider details).\n\n**Raw error (redacted):**\n\n> ${sample}\n\nSee Team Console → Status → Provider issues. Resolve it there once fixed.`,
      );
    }
  } catch (err) {
    logger.warn("provider_issue_record_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function listProviderIssues(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("provider_issues")
    .select("*")
    .or(`resolved_at.is.null,last_seen.gte.${since}`)
    .order("resolved_at", { ascending: false, nullsFirst: true })
    .order("last_seen", { ascending: false })
    .limit(100);
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

export async function resolveProviderIssue(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("provider_issues").update({ resolved_at: new Date().toISOString() }).eq("id", id).is("resolved_at", null);
  if (error) throw new HttpError(500, error.message);
}
