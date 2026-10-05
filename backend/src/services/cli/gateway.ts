import type { Response } from "express";
import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { logger } from "../../utils/logger.js";
import { sanitizeUserError } from "../../utils/providerError.js";
import { getWorkingKeyForProvider, isFrontierModel, listChatCandidates, type ChatCandidate } from "../providerService.js";
import { getProviderAdapter } from "../providers/registry.js";
import type { ToolCall, ToolSpec } from "../providers/toolCalling.js";
import { isBuildModel } from "../projectBuild/buildModels.js";
import { entitlementsFor, resolveEntitlements } from "../quota/entitlements.js";
import { creditsForInputTokens, creditsForUsage, meterRatesFor } from "../quota/meter.js";
import {
  canUseModelTier,
  checkAndReserve,
  chargeProgress,
  estimateReservationTokens,
  getQuotaStatus,
  QUOTA_STOP_MESSAGE,
  recordTokenLedger,
  reconcileQuota,
  resolveEffectivePlan,
} from "../quota/tokenQuotaService.js";
import { recordProviderIssue } from "../status/providerIssues.js";
import { estimateTokenUsageFromText, type TokenUsage } from "../tokenUsage.js";
import { recordTokenUsage } from "../usageService.js";
import {
  completionBody,
  finishChunk,
  modelRef,
  openAiError,
  parseModelRef,
  promptChars,
  textChunk,
  toAgentMessages,
  toolCallsChunk,
  toToolSpecs,
  usageChunk,
  type OaMessage,
  type OaTool,
} from "./openaiCompat.js";

/**
 * The FridayX model gateway: what the CLI / IDE extensions call instead of a model vendor. One request is
 * one model turn (the harness owns the agent loop and the transcript), and it is metered like every other
 * Friday call — same plan windows, same credits, same ledger — so usage in a terminal drains the exact
 * meter the user sees on web and mobile. Provider keys, routing and plan gating all stay server-side.
 */

export const AUTO_MODEL = "friday-x/auto";

const REASON_LABEL: Record<string, string> = {
  rolling_window: "You've hit your 5-hour usage limit",
  weekly: "You've hit your weekly usage limit",
  monthly: "You've hit your monthly usage limit",
  org_pool: "Your organization's usage pool is used up",
  member_cap: "You've hit the monthly cap your org admin set for you",
};

export const FRIDAY_X_NOT_INCLUDED = "FridayX isn't included in your plan. Upgrade your plan, or ask your admin to turn it on, to use it in the terminal and your editor.";

/** Throws unless this user's plan, package or admin grant includes FridayX. The one gate for the whole surface. */
export async function assertFridayX(userId: string): Promise<void> {
  const entitlements = await entitlementsFor(userId);
  if (!entitlements.fridayX) throw new HttpError(403, FRIDAY_X_NOT_INCLUDED);
}

function hasTools(slug: string): boolean {
  try {
    return typeof getProviderAdapter(slug).chatStreamWithTools === "function";
  } catch {
    return false;
  }
}

/**
 * Context window the harness should budget for. The server owns this (not the client), so correcting a
 * model's window is a backend change that every terminal and editor picks up at its next start. Matched on the
 * model id with the vendor prefix stripped, because OpenRouter-style ids carry one ("anthropic/claude-…").
 */
export function contextWindowFor(modelId: string): number {
  const id = modelId.toLowerCase().replace(/^[\w.-]+\//, "");
  if (/^gemini/.test(id)) return 1_000_000;
  if (/^gpt-4\.1/.test(id)) return 1_000_000;
  if (/^(gpt-5|o\d)/.test(id)) return 400_000;
  if (/^claude/.test(id)) return 200_000;
  if (/^(llama|qwen|deepseek|mistral|mixtral|sarvam|grok)/.test(id)) return 128_000;
  return 128_000;
}

export type CliModel = { id: string; name: string; provider: string; vision: boolean; recommended: boolean; locked: boolean; minTier: string; contextWindow: number };

/** The models this user can pick in FridayX: chat models that can drive tools, with plan-locked ones flagged (not hidden). */
export async function listCliModels(userId: string): Promise<{ default: string; models: CliModel[] }> {
  const candidates = (await listChatCandidates()).filter((c) => hasTools(c.slug));
  const models: CliModel[] = [];
  for (const c of candidates) {
    models.push({
      id: modelRef(c.slug, c.modelId),
      name: c.displayName,
      provider: c.providerDisplayName,
      vision: c.vision,
      recommended: isBuildModel({ slug: c.slug, modelId: c.modelId, displayName: c.displayName }),
      locked: !(await canUseModelTier(userId, c.minTier)),
      minTier: c.minTier,
      contextWindow: contextWindowFor(c.modelId),
    });
  }
  models.sort((a, b) => Number(a.locked) - Number(b.locked) || Number(b.recommended) - Number(a.recommended) || a.name.localeCompare(b.name));
  return { default: AUTO_MODEL, models };
}

/** "friday-x/auto" → the best coding model this user's plan allows; otherwise exactly the model asked for, if allowed. */
export async function resolveCliModel(userId: string, ref: string): Promise<ChatCandidate> {
  const candidates = (await listChatCandidates()).filter((c) => hasTools(c.slug));
  if (candidates.length === 0) throw new HttpError(503, "No model is available right now. Try again in a few minutes.");
  const usable: ChatCandidate[] = [];
  for (const c of candidates) if (await canUseModelTier(userId, c.minTier)) usable.push(c);

  if (!ref || ref === AUTO_MODEL || ref === "auto") {
    const pool = usable.length ? usable : [];
    const coding = pool.filter((c) => isBuildModel({ slug: c.slug, modelId: c.modelId, displayName: c.displayName }));
    const pick = coding[0] ?? pool.find(isFrontierModel) ?? pool[0];
    if (!pick) throw new HttpError(403, "None of the available models are included in your plan.");
    return pick;
  }
  const parsed = parseModelRef(ref);
  const found = parsed ? candidates.find((c) => c.slug === parsed.slug && c.modelId === parsed.modelId) : undefined;
  if (!found) throw new HttpError(404, `Unknown model "${ref}". Run \`friday models\` to see what's available.`);
  if (!usable.includes(found)) throw new HttpError(403, `${found.displayName} needs a higher plan. Pick another model, or upgrade.`);
  return found;
}

export type CliStatus = {
  plan: string;
  fridayX: boolean;
  usage: { windows: Array<{ label: string; percent: number; resetsAt: string }> };
};

const pct = (used: number, limit: number) => (limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0);

/** Percent-and-reset only, same as every other Friday surface — credits and prices never reach a client. */
export async function cliStatus(userId: string): Promise<CliStatus> {
  const [resolved, quota] = await Promise.all([resolveEntitlements(userId), getQuotaStatus(userId)]);
  const windows: CliStatus["usage"]["windows"] = [];
  if (quota.rolling) windows.push({ label: "5-hour", percent: pct(quota.rolling.used, quota.rolling.limit), resetsAt: quota.rolling.resetAt });
  if (!quota.isEnterprise) windows.push({ label: "Weekly", percent: pct(quota.weekly.used, quota.weekly.limit), resetsAt: quota.weekly.resetAt });
  if (quota.monthly) windows.push({ label: "Monthly", percent: pct(quota.monthly.used, quota.monthly.limit), resetsAt: quota.monthly.resetAt });
  if (quota.org) windows.push({ label: "Team pool", percent: pct(quota.org.used, quota.org.limit), resetsAt: quota.org.resetAt });
  if (quota.memberCap) windows.push({ label: "Your cap", percent: pct(quota.memberCap.used, quota.memberCap.limit), resetsAt: quota.org?.resetAt ?? quota.weekly.resetAt });
  return { plan: resolved.plan, fridayX: resolved.entitlements.fridayX, usage: { windows } };
}

export type CliUser = {
  userId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  subscriptionTier: string;
  codingDataRetentionOptOut: true;
};

/** `GET /v1/user` — who the terminal is signed in as (camelCase: that is the shape the client reads). */
export async function cliUser(userId: string): Promise<CliUser> {
  const [{ data }, profile, resolved] = await Promise.all([
    supabaseAdmin.auth.admin.getUserById(userId),
    supabaseAdmin.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
    resolveEntitlements(userId),
  ]);
  const [first = null, ...rest] = String(profile.data?.full_name ?? "").trim().split(/\s+/).filter(Boolean);
  return {
    userId,
    email: data.user?.email ?? null,
    firstName: first,
    lastName: rest.length ? rest.join(" ") : null,
    subscriptionTier: resolved.plan,
    // FridayX keeps no transcripts of a user's code for training; the client treats this as "opted out".
    codingDataRetentionOptOut: true,
  };
}

/**
 * `GET /v1/settings` — server-driven client settings. This is the lever for changing how every installed
 * terminal and editor behaves without shipping a new binary (a fleet kill switch for a feature, a release
 * channel…). Empty by default; `FRIDAY_X_SETTINGS_JSON` supplies a JSON object. Anything that isn't a plain
 * object is ignored rather than served, so a typo in the env var can't break every client's startup.
 */
export function cliSettings(): Record<string, unknown> {
  const raw = process.env.FRIDAY_X_SETTINGS_JSON?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export type CompletionRequest = {
  model?: string;
  messages?: OaMessage[];
  tools?: OaTool[];
  tool_choice?: unknown;
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
};

function sendJsonError(res: Response, status: number, message: string, type: string, code?: string) {
  res.status(status).json(openAiError(message, type, code));
}

/**
 * One metered model turn. Order: validate → pick the model → reserve credits (429 BEFORE any bytes are
 * sent) → charge the real prompt → call the provider → reconcile to the exact usage and write the ledger.
 */
export async function runCompletion(userId: string, body: CompletionRequest, res: Response, signal: AbortSignal): Promise<void> {
  const { registerPresence } = await import("../phone/store.js");
  registerPresence(userId, "cli");
  const messages = toAgentMessages(Array.isArray(body.messages) ? body.messages : []);
  if (!messages.some((m) => m.role === "user" || m.role === "tool")) return sendJsonError(res, 400, "`messages` needs at least one user message.", "invalid_request_error");
  const tools: ToolSpec[] = toToolSpecs(body.tools);
  const stream = body.stream !== false;

  let candidate: ChatCandidate;
  try {
    candidate = await resolveCliModel(userId, typeof body.model === "string" ? body.model : AUTO_MODEL);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    // A code the client can act on: model_unavailable / model_locked → re-read /api/x/models instead of trusting a stale list.
    const code = status === 404 ? "model_unavailable" : status === 403 ? "model_locked" : "model_error";
    return sendJsonError(res, status, err instanceof Error ? err.message : "Couldn't pick a model.", status === 403 ? "permission_error" : "invalid_request_error", code);
  }

  const chars = promptChars(messages, tools);
  const completionBuffer = Math.min(Math.max(body.max_completion_tokens ?? body.max_tokens ?? 4_000, 256), 16_000);
  const check = await checkAndReserve(userId, estimateReservationTokens(chars, completionBuffer));
  if (!check.allowed) {
    const retryAfter = Math.max(1, Math.ceil((check.resetAt.getTime() - Date.now()) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.setHeader("X-Quota-Reset", check.resetAt.toISOString());
    return sendJsonError(res, 429, `${REASON_LABEL[check.decision.reason] ?? "Usage limit reached"} — resets ${check.resetAt.toISOString()}.`, "rate_limit_error", `quota_${check.decision.reason}`);
  }
  const reservation = check.reservation;
  const rates = await meterRatesFor(candidate.slug, candidate.modelId);
  const pre = await chargeProgress(reservation, creditsForInputTokens(Math.ceil(chars / 4), rates));
  if (!pre.ok) {
    await reconcileQuota(reservation, 0).catch(() => undefined);
    return sendJsonError(res, 429, QUOTA_STOP_MESSAGE[pre.reason]!.replace(", so I stopped here.", "."), "rate_limit_error", `quota_${pre.reason}`);
  }

  const id = `chatcmpl-fx-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const modelName = modelRef(candidate.slug, candidate.modelId);
  let wroteHead = false;
  let first = true;
  const head = () => {
    if (wroteHead) return;
    wroteHead = true;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
  };
  const send = (payload: unknown) => {
    head();
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const onDelta = stream
    ? (text: string) => {
        if (!text) return;
        send(textChunk(id, modelName, text, first));
        first = false;
      }
    : () => undefined;

  let text = "";
  let calls: ToolCall[] = [];
  let usage: TokenUsage | null = null;
  try {
    const apiKey = await getWorkingKeyForProvider(candidate.slug);
    const adapter = getProviderAdapter(candidate.slug);
    const effort = body.reasoning_effort === "low" || body.reasoning_effort === "medium" || body.reasoning_effort === "high" ? body.reasoning_effort : undefined;
    if (adapter.chatStreamWithTools) {
      const turn = await adapter.chatStreamWithTools(
        apiKey,
        candidate.modelId,
        messages,
        { tools, toolChoice: body.tool_choice === "none" ? "none" : "auto", signal, maxTokens: body.max_completion_tokens ?? body.max_tokens, effort },
        onDelta,
      );
      text = turn.text;
      calls = turn.toolCalls;
      usage = turn.usage;
    } else {
      throw new Error(`${candidate.slug} can't run tools`);
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (signal.aborted) {
      // The client went away: charge what it actually consumed (nothing was delivered, estimate from the prompt only).
      await finalize(userId, candidate, reservation, rates, estimateTokenUsageFromText(chars, text.length));
      if (!res.writableEnded) res.end();
      return;
    }
    logger.warn("friday_x_provider_failed", { userId, provider: candidate.slug, model: candidate.modelId, error: raw.slice(0, 300) });
    void recordProviderIssue({ raw, userId, provider: candidate.slug });
    await finalize(userId, candidate, reservation, rates, estimateTokenUsageFromText(chars, text.length));
    const friendly = sanitizeUserError(raw);
    if (!wroteHead) return sendJsonError(res, 502, friendly, "api_error", "provider_unavailable");
    send({ error: { message: friendly, type: "api_error", code: "provider_unavailable" } });
    res.write("data: [DONE]\n\n");
    return void res.end();
  }

  // Providers that report no usage get an estimate, flagged — a turn is never metered as free.
  const finalUsage = usage ?? estimateTokenUsageFromText(chars, text.length + JSON.stringify(calls).length);
  await finalize(userId, candidate, reservation, rates, finalUsage);

  if (!stream) {
    res.json(completionBody(id, modelName, text, calls, finalUsage));
    return;
  }
  head();
  if (calls.length) {
    send(toolCallsChunk(id, modelName, calls, first));
    first = false;
  }
  send(finishChunk(id, modelName, calls.length ? "tool_calls" : "stop"));
  send(usageChunk(id, modelName, finalUsage));
  res.write("data: [DONE]\n\n");
  res.end();
}

async function finalize(
  userId: string,
  candidate: ChatCandidate,
  reservation: Parameters<typeof reconcileQuota>[0],
  rates: Awaited<ReturnType<typeof meterRatesFor>>,
  usage: TokenUsage,
): Promise<void> {
  const credits = creditsForUsage(usage, rates);
  await reconcileQuota(reservation, credits).catch((err) => logger.warn("friday_x_reconcile_failed", { userId, error: String(err) }));
  const effective = await resolveEffectivePlan(userId).catch(() => null);
  void recordTokenUsage(userId, candidate.slug, candidate.modelId, usage, { mode: "friday-x" });
  void recordTokenLedger(userId, effective?.enterprise?.organizationId ?? null, candidate.slug, candidate.modelId, usage, reservation.reserveTokens, "code");
}
