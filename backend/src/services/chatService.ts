import { supabaseAdmin } from "../config/supabase.js";
import { HttpError } from "../middleware/errorHandler.js";
import { getProviderAdapter } from "./providers/registry.js";
import type { ChatMessage } from "./providers/types.js";
import {
  getModelDisplayName,
  getWorkingKeyForProvider,
  listChatCandidates,
  type ChatCandidate,
} from "./providerService.js";
import { pickStrongest, rankCandidatesForMessage } from "./modelRouting.js";
import { searchWeb, type WebSearchResult } from "./webSearch.js";

export type StreamEvent =
  | { t: "status"; s: "thinking" | "searching" | "synthesizing" }
  | { t: "agent"; slug: string; model: string; state: "start" | "done" | "error"; error?: string }
  | { t: "text"; c: string }
  | { t: "think"; c: string }
  | { t: "cite"; u: string; title?: string }
  | { t: "err"; c: string }
  | { t: "done" };

export type ConversationMode = "single" | "auto" | "teamup";

// Smaller/weaker chat models (e.g. Sarvam) can get anchored on the previous topic in a long
// history and answer a short new message — "hii", "thanks", "ok" — as if it were a continuation
// of the last question instead of what it actually is. This keeps every provider focused on the
// message that was actually just sent.
const FOCUS_SYSTEM_PROMPT =
  "Always respond to the user's latest message specifically. Earlier messages in this conversation are context, not the question — if the latest message is a greeting, a short reaction, or changes topic, respond to that directly instead of continuing to elaborate on an earlier topic.";

// Keeps replies grounded instead of reflexively agreeable — a request that's factually wrong,
// physically impossible, or a bad idea should be told so plainly, not validated.
const HONESTY_SYSTEM_PROMPT =
  "Don't just agree with or validate whatever the user proposes. If a request or claim is factually " +
  "wrong, physically impossible, unsafe, or a bad idea, say so plainly and explain why instead of being " +
  "agreeable. When something is genuinely reasonable or achievable, be encouraging and helpful about it — " +
  "but stay honest and grounded rather than telling the user what they want to hear.";

// "Think" has no per-provider API today, so it's implemented as a universal system-prompt nudge
// that works the same across every adapter rather than a provider-specific reasoning param.
const THINK_SYSTEM_PROMPT =
  "Think through this step by step before answering. Reason carefully about the request, consider edge cases, then give a clear, direct final answer.";

function searchResultsToSystemMessage(results: WebSearchResult[]): ChatMessage {
  if (results.length === 0) {
    return {
      role: "system",
      content:
        "A live web search was run for this message but returned no results. Tell the user the search came back empty rather than claiming you have no web access at all.",
    };
  }
  const body = results.map((r, i) => `${i + 1}. ${r.title} (${r.url})\n${r.snippet}`).join("\n\n");
  return {
    role: "system",
    content:
      "You DO have live web access for THIS message: a real-time web search already ran and returned the results " +
      "below. You are not restricted to your training data here — treat these as current, authoritative " +
      "information and answer using them directly. If you said earlier in this same conversation that you " +
      "cannot browse the web or lack real-time access, that was true only for those earlier turns without " +
      "search — it does NOT apply now. Do not repeat that disclaimer here; you were just given real-time " +
      `results, so use them.\n\nWeb search results for the user's message:\n\n${body}\n\n` +
      "Answer the user's question using these results, citing the source (by name or URL) when you use one. If " +
      "none of the results actually answer the question, say so plainly instead of guessing.",
  };
}

// Every send refetches and resends the ENTIRE conversation history with no cap — fine for short
// chats, but a long-running one eventually exceeds a provider's context window outright (a hard
// 400 from the API, with no partial reply) and gets slower/costlier every single turn regardless.
// Team Up in particular fans the same history out to whichever smaller-context models happen to
// be enabled, so the budget has to hold for the smallest realistic context window, not just
// Claude/Gemini's much larger ones. ~90k chars (~22k tokens at a rough 4 chars/token) comfortably
// fits everything actually enabled today while still covering a genuinely long conversation.
const MAX_HISTORY_CHARS = 90_000;

/**
 * Keeps the most recent messages that fit within MAX_HISTORY_CHARS, always keeping at least the
 * latest message (a single very long paste can still exceed the budget on its own) and dropping
 * from the oldest end first — a simple, provider-agnostic stand-in for real summarization.
 */
function trimHistoryToBudget(history: ChatMessage[]): ChatMessage[] {
  let total = 0;
  let cutoff = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    total += history[i]!.content.length;
    if (total > MAX_HISTORY_CHARS && i < history.length - 1) {
      cutoff = i + 1;
      break;
    }
  }
  return history.slice(cutoff);
}

/** Prepends web search results, a persona/behavior instruction, and/or the Think nudge, in that order. */
function withSystemPreamble(
  history: ChatMessage[],
  think: boolean,
  behavior: string,
  webSearch: boolean,
  searchResults: WebSearchResult[],
): ChatMessage[] {
  const preamble: ChatMessage[] = [
    { role: "system", content: FOCUS_SYSTEM_PROMPT },
    { role: "system", content: HONESTY_SYSTEM_PROMPT },
  ];
  if (webSearch) preamble.push(searchResultsToSystemMessage(searchResults));
  if (behavior.trim()) preamble.push({ role: "system", content: behavior.trim() });
  if (think) preamble.push({ role: "system", content: THINK_SYSTEM_PROMPT });
  return preamble.length ? [...preamble, ...history] : history;
}

// Team Up fans a message out to at most this many distinct providers, one model each,
// so a single send doesn't burn through every configured key at once.
const TEAMUP_MAX_MODELS = 3;

async function getOwnedConversation(userId: string, conversationId: string) {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("*, providers(slug, display_name)")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new HttpError(404, "Conversation not found");
  return data as typeof data & { providers: { slug: string; display_name: string } | null };
}

export async function createConversation(
  userId: string,
  mode: ConversationMode,
  providerSlug?: string,
  modelId?: string,
  title?: string,
) {
  let providerRowId: string | null = null;

  if (mode === "single") {
    if (!providerSlug || !modelId) throw new HttpError(400, "providerSlug and modelId are required for single mode");
    const { data: provider, error: providerError } = await supabaseAdmin
      .from("providers")
      .select("id")
      .eq("slug", providerSlug)
      .single();
    if (providerError || !provider) throw new HttpError(400, `Unknown provider: ${providerSlug}`);
    providerRowId = provider.id;
  }

  const defaultTitle = mode === "auto" ? "Auto chat" : mode === "teamup" ? "Team Up chat" : "New chat";

  const { data, error } = await supabaseAdmin
    .from("conversations")
    .insert({
      user_id: userId,
      provider_id: providerRowId,
      model_id: mode === "single" ? modelId : null,
      mode,
      title: title || defaultTitle,
    })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to create conversation");
  return data;
}

/**
 * Switches which model/mode an existing conversation answers with, effective from the next
 * message onward — used when the user picks a different model mid-conversation instead of only
 * at creation time.
 */
export async function updateConversationModel(
  userId: string,
  conversationId: string,
  mode: ConversationMode,
  providerSlug?: string,
  modelId?: string,
) {
  await getOwnedConversation(userId, conversationId);

  let providerRowId: string | null = null;
  if (mode === "single") {
    if (!providerSlug || !modelId) throw new HttpError(400, "providerSlug and modelId are required for single mode");
    const { data: provider, error: providerError } = await supabaseAdmin
      .from("providers")
      .select("id")
      .eq("slug", providerSlug)
      .single();
    if (providerError || !provider) throw new HttpError(400, `Unknown provider: ${providerSlug}`);
    providerRowId = provider.id;
  }

  const { data, error } = await supabaseAdmin
    .from("conversations")
    .update({
      provider_id: providerRowId,
      model_id: mode === "single" ? (modelId ?? null) : null,
      mode,
    })
    .eq("id", conversationId)
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to switch model");
  return data;
}

export async function listConversations(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("*, providers(slug, display_name)")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw new HttpError(500, error.message);
  return data;
}

export async function deleteConversation(userId: string, conversationId: string) {
  await getOwnedConversation(userId, conversationId);
  const { error } = await supabaseAdmin.from("conversations").delete().eq("id", conversationId);
  if (error) throw new HttpError(500, error.message);
}

export async function listMessages(userId: string, conversationId: string) {
  await getOwnedConversation(userId, conversationId);
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at");
  if (error) throw new HttpError(500, error.message);
  return data;
}

async function insertAssistantMessage(conversationId: string, content: string, modelLabel: string) {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .insert({ conversation_id: conversationId, role: "assistant", content, model_label: modelLabel })
    .select()
    .single();
  if (error || !data) throw new HttpError(500, error?.message ?? "Failed to save reply");
  return data;
}

// adapter.chat() has no abort signal, so a slow/stuck provider (a local Ollama model with no
// GPU, a network stall) can hang a fetch indefinitely. That's fatal for Auto/Team Up, which wait
// on multiple candidates — one hung candidate blocks the whole reply forever with no error shown.
// This bounds every non-streaming call so a stuck candidate fails instead of hanging the request.
//
// Confirmed in production (2026-09-16): Team Up proposers and the synthesis call are always
// non-streaming (callCandidate), and a reasoning ("Think") model working over a long context can
// easily run past a minute before it has anything to return. At 45s that reads as every proposer
// erroring out ("Every model in the team failed to respond") — indistinguishable from the whole
// feature randomly dying mid-thought. 45s was tuned for a stuck/hung connection, not a slow-but-
// working one; raised well above realistic Think/long-context latency so it only fires on an
// actually-dead request.
const CANDIDATE_TIMEOUT_MS = 150_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const id = setTimeout(() => reject(new Error(`${label} took too long to respond`)), ms);
      // NOT `promise.finally(...)`: `.finally()` returns a new derived promise that re-throws
      // the original rejection, and nothing here holds onto or awaits that derived promise. If
      // `promise` rejects after this race has already settled via the timeout branch (a slow
      // provider that eventually errors — confirmed in production against a Cloudflare 524 from
      // ScaleMax), that orphaned derived promise becomes an unhandled rejection and crashes the
      // whole Node process, taking down every other in-flight request with it. `.then` with both
      // handlers clears the timer without producing a floating rejection.
      promise.then(
        () => clearTimeout(id),
        () => clearTimeout(id),
      );
    }),
  ]);
}

async function callCandidate(candidate: ChatCandidate, history: ChatMessage[]): Promise<string> {
  const adapter = getProviderAdapter(candidate.slug);
  const apiKey = await getWorkingKeyForProvider(candidate.slug);
  return withTimeout(adapter.chat(apiKey, candidate.modelId, history), CANDIDATE_TIMEOUT_MS, candidate.slug);
}

/** Picks distinct providers so Team Up compares different vendors rather than two models from one. */
function pickDistinctProviders(candidates: ChatCandidate[], limit: number): ChatCandidate[] {
  const seen = new Set<string>();
  const picked: ChatCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    picked.push(c);
    if (picked.length >= limit) break;
  }
  return picked;
}

const SYNTHESIS_SYSTEM_PROMPT =
  "You are given the original request and several draft answers from different AI models. Write ONE final " +
  "answer that combines their strongest parts, resolves any disagreements between them, and corrects anything " +
  "wrong or weak in any draft. Answer as if you were asked directly — don't mention the drafts, the other " +
  "models, or that this is a synthesis.";

/** Mixture-of-agents: merges Team Up's parallel drafts into a single best final answer. */
function buildSynthesisMessages(
  originalMessage: string,
  drafts: { candidate: ChatCandidate; text: string }[],
  grounding: ChatMessage[] = [],
): ChatMessage[] {
  const draftsBlock = drafts
    .map((d, i) => `Draft ${i + 1} (${d.candidate.displayName}):\n${d.text}`)
    .join("\n\n---\n\n");
  return [
    ...grounding,
    { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
    { role: "user", content: `Original request:\n${originalMessage}\n\n${draftsBlock}` },
  ];
}

async function synthesizeDrafts(
  pool: ChatCandidate[],
  originalMessage: string,
  drafts: { candidate: ChatCandidate; text: string }[],
): Promise<{ candidate: ChatCandidate; text: string } | null> {
  if (pool.length === 0) return null;
  const synthCandidate = pickStrongest(pool);
  const text = await callCandidate(synthCandidate, buildSynthesisMessages(originalMessage, drafts));
  return { candidate: synthCandidate, text };
}

export async function sendMessage(
  userId: string,
  conversationId: string,
  content: string,
  inputMode: "text" | "voice" = "text",
  think = false,
  behavior = "",
  webSearch = false,
) {
  const conversation = await getOwnedConversation(userId, conversationId);

  const { error: insertError } = await supabaseAdmin
    .from("messages")
    .insert({ conversation_id: conversationId, role: "user", content, input_mode: inputMode });
  if (insertError) throw new HttpError(500, insertError.message);

  const { data: historyRows, error: historyError } = await supabaseAdmin
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at");
  if (historyError) throw new HttpError(500, historyError.message);

  const searchResults = webSearch ? await searchWeb(content).catch(() => []) : [];
  const history = withSystemPreamble(trimHistoryToBudget(historyRows as ChatMessage[]), think, behavior, webSearch, searchResults);

  const mode = conversation.mode as ConversationMode;
  let replies: Awaited<ReturnType<typeof insertAssistantMessage>>[];

  if (mode === "single") {
    if (!conversation.providers || !conversation.model_id) {
      throw new HttpError(500, "Conversation is missing its provider/model");
    }
    const displayName = await getModelDisplayName(conversation.provider_id as string, conversation.model_id);
    const text = await callCandidate(
      { slug: conversation.providers.slug, providerDisplayName: conversation.providers.display_name, modelId: conversation.model_id, displayName },
      history,
    );
    replies = [await insertAssistantMessage(conversationId, text, displayName)];
  } else if (mode === "auto") {
    const candidates = rankCandidatesForMessage(await listChatCandidates(), content);
    if (candidates.length === 0) throw new HttpError(503, "No chat models are enabled yet");

    const errors: string[] = [];
    let reply: Awaited<ReturnType<typeof insertAssistantMessage>> | null = null;
    for (const candidate of candidates) {
      try {
        const text = await callCandidate(candidate, history);
        reply = await insertAssistantMessage(conversationId, text, `Auto → ${candidate.displayName}`);
        break;
      } catch (err) {
        errors.push(`${candidate.slug}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    if (!reply) throw new HttpError(503, `Every model failed. ${errors.join("; ")}`);
    replies = [reply];
  } else {
    // teamup — proposers answer in parallel, then a synthesizer model merges their drafts into
    // one final answer (mixture-of-agents). Drafts are saved too, right after, so the synthesis
    // can be checked against what actually went into it.
    const pool = await listChatCandidates();
    const candidates = pickDistinctProviders(pool, TEAMUP_MAX_MODELS);
    if (candidates.length === 0) throw new HttpError(503, "No chat models are enabled yet");

    const results = await Promise.allSettled(
      candidates.map(async (candidate) => ({
        candidate,
        text: await callCandidate(candidate, history),
      })),
    );
    const drafts = results
      .filter((r): r is PromiseFulfilledResult<{ candidate: ChatCandidate; text: string }> => r.status === "fulfilled")
      .map((r) => r.value);
    if (drafts.length === 0) throw new HttpError(503, "Every model in the team failed to respond");

    const inserted: Awaited<ReturnType<typeof insertAssistantMessage>>[] = [];
    if (drafts.length > 1) {
      const synthesis = await synthesizeDrafts(pool, content, drafts).catch(() => null);
      if (synthesis) {
        inserted.push(
          await insertAssistantMessage(conversationId, synthesis.text, `Team → ${synthesis.candidate.displayName}`),
        );
      }
    }
    for (const d of drafts) {
      inserted.push(await insertAssistantMessage(conversationId, d.text, `Draft — ${d.candidate.displayName}`));
    }
    replies = inserted;
  }

  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);

  return replies;
}

/**
 * Team Up's streaming path: runs proposers concurrently, emitting an `agent` event as each one
 * starts/finishes/fails so the client can render a live "council" list, then streams the
 * synthesizer's merged final answer token-by-token exactly like a single model reply.
 */
async function streamTeamUp(
  conversationId: string,
  content: string,
  history: ChatMessage[],
  searchResults: WebSearchResult[],
  webSearch: boolean,
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const pool = await listChatCandidates();
  const proposers = pickDistinctProviders(pool, TEAMUP_MAX_MODELS);
  if (proposers.length === 0) {
    onEvent({ t: "err", c: "No chat models are enabled yet" });
    onEvent({ t: "done" });
    return;
  }

  onEvent({ t: "status", s: "thinking" });

  const settled = await Promise.all(
    proposers.map(async (candidate) => {
      onEvent({ t: "agent", slug: candidate.slug, model: candidate.displayName, state: "start" });
      try {
        const text = await callCandidate(candidate, history);
        onEvent({ t: "agent", slug: candidate.slug, model: candidate.displayName, state: "done" });
        return { candidate, text };
      } catch (err) {
        onEvent({
          t: "agent",
          slug: candidate.slug,
          model: candidate.displayName,
          state: "error",
          error: err instanceof Error ? err.message : "failed",
        });
        return null;
      }
    }),
  );
  const drafts = settled.filter((d): d is { candidate: ChatCandidate; text: string } => d !== null);

  if (drafts.length === 0) {
    onEvent({ t: "err", c: "Every model in the team failed to respond" });
    onEvent({ t: "done" });
    return;
  }

  let finalCandidate: ChatCandidate;
  let full: string;

  if (drafts.length === 1) {
    // Nothing to synthesize against — the lone draft just is the final answer.
    finalCandidate = drafts[0]!.candidate;
    full = drafts[0]!.text;
    onEvent({ t: "text", c: full });
  } else {
    onEvent({ t: "status", s: "synthesizing" });
    finalCandidate = pickStrongest(pool);
    const grounding = webSearch ? [searchResultsToSystemMessage(searchResults)] : [];
    const synthMessages = buildSynthesisMessages(content, drafts, grounding);
    const adapter = getProviderAdapter(finalCandidate.slug);
    const apiKey = await getWorkingKeyForProvider(finalCandidate.slug);
    if (adapter.chatStream) {
      full = await adapter.chatStream(
        apiKey,
        finalCandidate.modelId,
        synthMessages,
        (delta) => onEvent({ t: "text", c: delta }),
        signal,
        (think) => onEvent({ t: "think", c: think }),
      );
    } else {
      full = await adapter.chat(apiKey, finalCandidate.modelId, synthMessages);
      onEvent({ t: "text", c: full });
    }
  }

  const label = drafts.length > 1 ? `Team → ${finalCandidate.displayName}` : finalCandidate.displayName;
  await insertAssistantMessage(conversationId, full, label);
  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  onEvent({ t: "done" });
}

/**
 * Streams a reply token-by-token via `onEvent`. Single/Auto stream one model's answer directly;
 * Team Up runs its proposers concurrently (emitting `agent` start/done/error events for each so
 * the client can show a live "council" of who's answering) and then streams the synthesizer's
 * merged final answer the same way a single model would.
 */
export async function streamMessage(
  userId: string,
  conversationId: string,
  content: string,
  inputMode: "text" | "voice",
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal,
  think = false,
  behavior = "",
  webSearch = false,
): Promise<void> {
  const conversation = await getOwnedConversation(userId, conversationId);
  const mode = conversation.mode as ConversationMode;

  const { error: insertError } = await supabaseAdmin
    .from("messages")
    .insert({ conversation_id: conversationId, role: "user", content, input_mode: inputMode });
  if (insertError) throw new HttpError(500, insertError.message);

  const { data: historyRows, error: historyError } = await supabaseAdmin
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at");
  if (historyError) throw new HttpError(500, historyError.message);

  let searchResults: Awaited<ReturnType<typeof searchWeb>> = [];
  if (webSearch) {
    onEvent({ t: "status", s: "searching" });
    searchResults = await searchWeb(content).catch(() => []);
    console.log(`[chat] web search "${content}" -> ${searchResults.length} results`);
    for (const r of searchResults) onEvent({ t: "cite", u: r.url, title: r.title });
  }
  const history = withSystemPreamble(trimHistoryToBudget(historyRows as ChatMessage[]), think, behavior, webSearch, searchResults);

  if (mode === "teamup") {
    await streamTeamUp(conversationId, content, history, searchResults, webSearch, onEvent, signal);
    return;
  }

  let candidates: ChatCandidate[];
  if (mode === "single") {
    if (!conversation.providers || !conversation.model_id) {
      throw new HttpError(500, "Conversation is missing its provider/model");
    }
    candidates = [
      {
        slug: conversation.providers.slug,
        providerDisplayName: conversation.providers.display_name,
        modelId: conversation.model_id,
        displayName: await getModelDisplayName(conversation.provider_id as string, conversation.model_id),
      },
    ];
  } else {
    candidates = rankCandidatesForMessage(await listChatCandidates(), content);
    if (candidates.length === 0) throw new HttpError(503, "No chat models are enabled yet");
  }

  onEvent({ t: "status", s: "thinking" });

  let usedCandidate: ChatCandidate | null = null;
  let full = "";
  let lastError: string | undefined;

  for (const candidate of candidates) {
    const adapter = getProviderAdapter(candidate.slug);
    const apiKey = await getWorkingKeyForProvider(candidate.slug);
    let started = false;
    let text = "";
    try {
      if (adapter.chatStream) {
        text = await adapter.chatStream(
          apiKey,
          candidate.modelId,
          history,
          (delta) => {
            started = true;
            onEvent({ t: "text", c: delta });
          },
          signal,
          (think) => {
            started = true;
            onEvent({ t: "think", c: think });
          },
        );
      } else {
        text = await adapter.chat(apiKey, candidate.modelId, history);
        started = true;
        onEvent({ t: "text", c: text });
      }
      full = text;
      usedCandidate = candidate;
      break;
    } catch (err) {
      lastError = `${candidate.slug}: ${err instanceof Error ? err.message : "failed"}`;
      // Already streamed partial text for this reply — cannot silently retry another
      // candidate without confusing the client with two overlapping replies.
      if (started) break;
    }
  }

  if (!usedCandidate) {
    onEvent({ t: "err", c: lastError ?? "The model failed to respond" });
    onEvent({ t: "done" });
    return;
  }

  const label = mode === "auto" ? `Auto → ${usedCandidate.displayName}` : usedCandidate.displayName;
  await insertAssistantMessage(conversationId, full, label);
  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  onEvent({ t: "done" });
}
