import { supabaseAdmin } from "../../config/supabase.js";
import { memoAsync } from "../../utils/ttlMemo.js";
import { quotaRpc } from "./tokenQuotaService.js";

/**
 * The usage dashboard's breakdown of one period, read from the ledger (the same rows the balance is
 * made of, so the two can't disagree). Models are shown by their Friday display name and the
 * company that makes them — never the reseller we route through.
 */

const modelNames = memoAsync(
  10 * 60_000,
  async () => {
    const { data } = await supabaseAdmin.from("provider_models").select("model_id, display_name, providers(slug)");
    const map = new Map<string, string>();
    for (const row of data ?? []) {
      const provider = row.providers as { slug?: string } | { slug?: string }[] | null;
      const slug = Array.isArray(provider) ? provider[0]?.slug : provider?.slug;
      if (slug && row.display_name) map.set(`${slug}/${row.model_id}`, row.display_name as string);
    }
    return map;
  },
  () => "models",
);

/** The company behind a model, from its id — what a customer recognises ("Anthropic", "OpenAI"…). */
export function modelVendor(modelId: string): string {
  const id = modelId.toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(id)) return "Anthropic";
  if (/gemini|gemma/.test(id)) return "Google";
  if (/(^|[/-])(gpt|o\d|chatgpt|dall-e|gpt-image)/.test(id)) return "OpenAI";
  if (/grok/.test(id)) return "xAI";
  if (/llama/.test(id)) return "Meta";
  if (/mistral|mixtral|codestral/.test(id)) return "Mistral";
  if (/deepseek/.test(id)) return "DeepSeek";
  if (/qwen/.test(id)) return "Alibaba";
  if (/sarvam/.test(id)) return "Sarvam";
  return "Other";
}

type Num = number | string | null | undefined;
const n = (v: Num) => (v == null ? 0 : Number(v) || 0);

export type UsageReport = {
  totals: { calls: number; billable: number; input: number; output: number; cached: number; reasoning: number; estimatedBillable: number };
  byModel: Array<{ model: string; vendor: string; calls: number; billable: number; input: number; output: number; cached: number; reasoning: number; estimatedBillable: number }>;
  byFeature: Array<{ feature: string; calls: number; billable: number }>;
  byDay: Array<{ day: string; billable: number }>;
  recent: Array<{ at: string; model: string; feature: string; input: number; output: number; billable: number; source: string; status: string }>;
  adjustments: Array<{ at: string; kind: string; tokens: number; reason: string }>;
};

export async function usageReport(accountId: string, periodStart: string, userId: string | null, opts: { includeAdjustments: boolean }): Promise<UsageReport> {
  const [raw, names, recentRows, adjustmentRows] = await Promise.all([
    quotaRpc<Record<string, unknown>>("quota_usage_report", { p_account: accountId, p_user: userId, p_period: periodStart }),
    modelNames().catch(() => new Map<string, string>()),
    (() => {
      let q = supabaseAdmin
        .from("token_ledger")
        .select("created_at, provider_slug, model_id, feature, input_tokens, output_tokens, billable_tokens, usage_source, call_status")
        .eq("account_id", accountId)
        .eq("period_start", periodStart)
        .order("created_at", { ascending: false })
        .limit(40);
      if (userId) q = q.eq("user_id", userId);
      return q;
    })(),
    opts.includeAdjustments
      ? supabaseAdmin.from("quota_adjustments").select("created_at, kind, tokens, reason").eq("account_id", accountId).eq("period_start", periodStart).order("created_at", { ascending: false }).limit(50)
      : Promise.resolve({ data: [] }),
  ]);
  const label = (slug: string, modelId: string) => names.get(`${slug}/${modelId}`) ?? modelId;
  const totals = (raw.totals ?? {}) as Record<string, Num>;
  return {
    totals: {
      calls: n(totals.calls),
      billable: n(totals.billable),
      input: n(totals.input),
      output: n(totals.output),
      cached: n(totals.cached),
      reasoning: n(totals.reasoning),
      estimatedBillable: n(totals.estimated_billable),
    },
    byModel: ((raw.by_model ?? []) as Array<Record<string, Num>>).map((m) => ({
      model: label(String(m.provider_slug), String(m.model_id)),
      vendor: modelVendor(String(m.model_id)),
      calls: n(m.calls),
      billable: n(m.billable),
      input: n(m.input),
      output: n(m.output),
      cached: n(m.cached),
      reasoning: n(m.reasoning),
      estimatedBillable: n(m.estimated_billable),
    })),
    byFeature: ((raw.by_feature ?? []) as Array<Record<string, Num>>).map((f) => ({ feature: String(f.feature), calls: n(f.calls), billable: n(f.billable) })),
    byDay: ((raw.by_day ?? []) as Array<Record<string, Num>>).map((d) => ({ day: String(d.day), billable: n(d.billable) })),
    recent: ((recentRows.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      at: String(r.created_at),
      model: label(String(r.provider_slug), String(r.model_id)),
      feature: String(r.feature ?? "chat"),
      input: n(r.input_tokens as Num),
      output: n(r.output_tokens as Num),
      billable: n(r.billable_tokens as Num),
      source: String(r.usage_source ?? "provider"),
      status: String(r.call_status ?? "ok"),
    })),
    adjustments: ((adjustmentRows.data ?? []) as Array<Record<string, unknown>>).map((a) => ({
      at: String(a.created_at),
      kind: String(a.kind),
      tokens: n(a.tokens as Num),
      reason: String(a.reason ?? ""),
    })),
  };
}
