import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { getProviderAdapter } from "../providers/registry.js";
import type { ChatImage, ChatMessage } from "../providers/types.js";
import {
  getModelDisplayName,
  getModelMinTier,
  getModelVisionSupport,
  getWorkingKeyForProvider,
  listChatCandidates,
  type ChatCandidate,
} from "../providerService.js";
import { rankCandidatesForMessage } from "../modelRouting.js";
import { searchWeb } from "../webSearch.js";
import { recordTokenUsage, recordUsageEvent } from "../usageService.js";
import {
  emptyTokenUsage,
  estimateTokenUsageFromText,
  type TokenUsage,
} from "../tokenUsage.js";
import { detectNeedsLiveSearch } from "./liveSearchIntent.js";
import { digitiseDocument, isDigitisable } from "../providers/sarvamDocAI.js";
import { extractOfficeText, isOfficeDocument } from "../providers/officeDocs.js";
import {
  appendExtractedText,
  attachImages,
  trimHistoryToBudget,
  unsupportedAttachmentReason,
  withSystemPreamble,
} from "./promptContext.js";
import { streamTeamUp } from "./teamUp.js";
import { getOwnedConversation, insertAssistantMessage, insertUserMessage } from "./conversations.js";
import type { ConversationMode, StreamEvent } from "./types.js";
import { planSatisfiesTier } from "../quota/tierConfig.js";
import {
  reconcileQuota,
  recordTokenLedger,
  resolveEffectivePlan,
  type Reservation,
} from "../quota/tokenQuotaService.js";

export type { StreamEvent, ConversationMode } from "./types.js";
export {
  createConversation,
  updateConversationModel,
  listConversations,
  deleteConversation,
  deleteAllConversations,
  listMessages,
} from "./conversations.js";

/**
 * Extracts text from every PDF/PNG/JPEG/DOCX/XLSX attachment and returns it combined, or null if
 * nothing extractable was attached or every extraction failed. PDF/image goes through Sarvam's
 * Doc AI digitise pipeline (OCR — verified directly against the real API); DOCX/XLSX are parsed
 * locally (mammoth/exceljs — these are structured XML formats, not scanned documents, and
 * Sarvam's API rejects them outright, confirmed directly: "only JPEG and PNG entries are
 * allowed"). Never throws — extraction is a best-effort enhancement layered on top of (not
 * required for) whatever native support the chosen model already has. This is what makes any of
 * these files readable by ANY model, not just ones with native document/vision support, and gives
 * even a non-vision model a way to "read" an image's text.
 */
async function extractDocumentText(attachments: ChatImage[]): Promise<string | null> {
  const officeFiles = attachments.filter((a) => isOfficeDocument(a.mime));
  const digitisableFiles = attachments.filter((a) => isDigitisable(a.mime));
  if (officeFiles.length === 0 && digitisableFiles.length === 0) return null;

  const officeTexts = officeFiles.map((f) => extractOfficeText(f.dataUrl, f.mime));
  const digitiseTexts = (async () => {
    if (digitisableFiles.length === 0) return [];
    const sarvamKey = await getWorkingKeyForProvider("sarvam").catch(() => null);
    if (!sarvamKey) return digitisableFiles.map(() => Promise.resolve(null));
    return digitisableFiles.map((f, i) => digitiseDocument(sarvamKey, f.dataUrl, f.mime, `attachment-${i + 1}`));
  })();

  const [officeResults, digitiseResultPromises] = await Promise.all([Promise.all(officeTexts), digitiseTexts]);
  const digitiseResults = await Promise.all(digitiseResultPromises);
  const allResults = [...officeResults, ...digitiseResults];

  const extracted = allResults
    .map((text, i) => (text ? (allResults.length > 1 ? `[Attachment ${i + 1}]\n${text}` : text) : null))
    .filter((t): t is string => t !== null);
  return extracted.length > 0 ? extracted.join("\n\n") : null;
}

/**
 * Streams a reply token-by-token via `onEvent`. Single/Auto stream one model's answer directly;
 * Team Up runs its proposers concurrently (emitting `agent` start/done/error events for each so
 * the client can show a live "council" of who's answering) and then streams the synthesizer's
 * merged final answer the same way a single model would.
 *
 * `reservation` is the token-quota pre-flight reservation the chat route's `quotaLimit`
 * middleware already made (see quotaLimit.ts) — every exit path below reconciles it in the
 * `finally` block via `reconcileTokens`, which defaults to 0 (a full refund) and is only set to
 * the real total right before the message that actually spent tokens is recorded. Team Up isn't
 * wired into the quota system yet — its reservation (sized for one message) always gets fully
 * refunded here, i.e. it stays unmetered for now.
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
  canvas = false,
  attachments: ChatImage[] = [],
  reservation?: Reservation,
): Promise<void> {
  let reconcileTokens = 0;
  try {
    const conversation = await getOwnedConversation(userId, conversationId);
    const mode = conversation.mode as ConversationMode;

    await insertUserMessage(conversationId, content, inputMode, attachments, userId);
    void recordUsageEvent(userId, "chat_message", 1, { mode, inputMode });
    if (attachments.length > 0) {
      void recordUsageEvent(userId, "attachment_upload", attachments.length, {
        totalBytes: attachments.reduce((sum, attachment) => sum + (attachment.size ?? 0), 0),
      });
    }

    const { data: historyRows, error: historyError } = await supabaseAdmin
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at");
    if (historyError) throw new HttpError(500, historyError.message);

    // Confirmed live in production: Search blindly ran on the literal message text regardless of
    // whether that text was an actual query — a screenshot attached with the caption "see" searched
    // the web for the word "see" and got back Thai-English dictionary entries. A short caption next
    // to a fresh attachment is a reference to the attachment ("look at this"), not a search query,
    // so it's skipped here rather than handed to a search API that has no way to know that.
    const SHORT_CAPTION_CHARS = 20;
    const looksLikeSearchQuery = attachments.length === 0 || content.trim().length >= SHORT_CAPTION_CHARS;

    // If the user didn't already toggle Search on, ask the model itself whether this specific
    // message actually needs live/current information — see liveSearchIntent.ts for why that beats
    // a keyword list. Skipped entirely when Search is already on (nothing to detect) or the message
    // doesn't look like a real query (short caption on an attachment).
    const autoSearch =
      !webSearch && looksLikeSearchQuery && content.trim().length > 0
        ? await detectNeedsLiveSearch(content)
        : false;
    const effectiveWebSearch = webSearch || autoSearch;

    // Gates both the actual search call AND the "a search ran" system message below — skipping the
    // fetch but still telling the model a search happened (and came back empty) would be its own
    // false statement, not an improvement on the original bug.
    const searchActuallyRan = effectiveWebSearch && looksLikeSearchQuery;

    let searchResults: Awaited<ReturnType<typeof searchWeb>> = [];
    if (searchActuallyRan) {
      onEvent({ t: "status", s: "searching" });
      searchResults = await searchWeb(content).catch(() => []);
      void recordUsageEvent(userId, "web_search", 1, { resultCount: searchResults.length, auto: autoSearch });
      console.log(`[chat] web search "${content}" -> ${searchResults.length} results`);
      for (const r of searchResults) onEvent({ t: "cite", u: r.url, title: r.title });
    }
    const extractedDocText = await extractDocumentText(attachments);
    // DOCX/XLSX have no native fallback on ANY provider — extraction succeeding is the only way
    // one of these ever reaches the model at all, so a failure here (corrupt file, unsupported
    // internal structure) needs to surface regardless of mode, not just single's per-provider
    // gates below. Checked once, up front, before any mode-specific branching.
    const hasOfficeAttachment = attachments.some((a) => isOfficeDocument(a.mime));
    if (hasOfficeAttachment && !extractedDocText) {
      onEvent({ t: "err", c: "Couldn't read that document — it may be corrupted or empty." });
      onEvent({ t: "done" });
      return;
    }
    const project = conversation.assistant_projects;
    const projectContext: ChatMessage[] = project
      ? [
          {
            role: "system",
            content: [
              `Project: ${project.name}`,
              `Mode: ${project.mode}`,
              project.description ? `Description: ${project.description}` : null,
              project.repository_url ? `Repository: ${project.repository_url}` : null,
              project.instructions ? `Project instructions:\n${project.instructions}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ]
      : [];

    const history = appendExtractedText(
      attachImages(
        withSystemPreamble(
          trimHistoryToBudget([...projectContext, ...(historyRows as ChatMessage[])]),
          think,
          behavior,
          searchActuallyRan,
          searchResults,
          canvas,
          attachments.length > 0,
        ),
        attachments,
      ),
      extractedDocText,
    );

    if (mode === "teamup") {
      await streamTeamUp(conversationId, content, history, searchResults, searchActuallyRan, onEvent, signal, {
        think,
        canvas,
      });
      return;
    }

    let candidates: ChatCandidate[];
    if (mode === "single") {
      if (!conversation.providers || !conversation.model_id) {
        throw new HttpError(500, "Conversation is missing its provider/model");
      }
      // The vision gate is about actual images needing a multimodal-capable model to see the raw
      // pixels — but Sarvam's OCR extraction gives a non-vision model a way to "read" an image's
      // text too, so this only blocks when there's an image AND extraction didn't already cover it
      // (no working Sarvam key, or OCR found nothing — e.g. a low-resolution image with no legible
      // text, confirmed directly against the real API).
      const hasImageAttachment = attachments.some((a) => a.mime.startsWith("image/"));
      const vision = await getModelVisionSupport(conversation.provider_id as string, conversation.model_id);
      if (hasImageAttachment && !vision && !extractedDocText) {
        onEvent({
          t: "err",
          c: `${conversation.providers.display_name} can't see images — pick a vision-capable model or remove the attachment.`,
        });
        onEvent({ t: "done" });
        return;
      }
      // Only a gate now, not the primary path — extractedDocText being non-null means Sarvam
      // already turned the PDF into text that ANY model can read, so a PDF-incapable model is only
      // actually blocked here if that extraction also failed/wasn't available.
      const unsupportedReason = extractedDocText
        ? null
        : unsupportedAttachmentReason(conversation.providers.slug, attachments);
      if (unsupportedReason) {
        onEvent({ t: "err", c: `${conversation.providers.display_name} ${unsupportedReason}` });
        onEvent({ t: "done" });
        return;
      }
      const minTier = await getModelMinTier(conversation.provider_id as string, conversation.model_id);
      candidates = [
        {
          slug: conversation.providers.slug,
          providerDisplayName: conversation.providers.display_name,
          modelId: conversation.model_id,
          displayName: await getModelDisplayName(conversation.provider_id as string, conversation.model_id),
          vision,
          minTier,
        },
      ];
    } else {
      candidates = rankCandidatesForMessage(await listChatCandidates(), content);
      if (candidates.length === 0) throw new HttpError(503, "No chat models are enabled yet");
    }

    // Plan/tier gate — separate from the token-quota reservation the route middleware already
    // made (that's "can you spend tokens at all"; this is "can you use THIS model"). Resolved
    // once here since it needs the actual candidate(s), which the middleware doesn't have.
    const effectivePlan = await resolveEffectivePlan(userId);
    const tierAllows = (c: ChatCandidate) =>
      effectivePlan.enterprise != null || planSatisfiesTier(effectivePlan.plan, c.minTier);
    if (mode === "single") {
      if (!tierAllows(candidates[0]!)) {
        onEvent({
          t: "err",
          c: `${candidates[0]!.displayName} needs a higher plan — upgrade to unlock it.`,
        });
        onEvent({ t: "done" });
        return;
      }
    } else {
      candidates = candidates.filter(tierAllows);
      if (candidates.length === 0) {
        onEvent({ t: "err", c: "No chat models are available on your current plan yet — upgrade to unlock more." });
        onEvent({ t: "done" });
        return;
      }
    }

    onEvent({ t: "status", s: "thinking" });

    let usedCandidate: ChatCandidate | null = null;
    let full = "";
    let thinking = "";
    let lastError: string | undefined;
    let tokenUsage: TokenUsage = emptyTokenUsage();
    let sawProviderUsage = false;

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
            (thinkDelta) => {
              started = true;
              thinking += thinkDelta;
              onEvent({ t: "think", c: thinkDelta });
            },
            (usage) => {
              tokenUsage = usage;
              sawProviderUsage = true;
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

    if (!sawProviderUsage || tokenUsage.totalTokens <= 0) {
      const promptChars = history.reduce((sum, message) => sum + message.content.length, 0);
      tokenUsage = estimateTokenUsageFromText(promptChars, full.length + thinking.length);
    }
    // The actual count is now known — this is what reconcileQuota corrects the pre-flight
    // reservation to in the finally block below.
    reconcileTokens = tokenUsage.totalTokens;

    void recordTokenUsage(userId, usedCandidate.slug, usedCandidate.modelId, tokenUsage, {
      conversationId,
      mode,
    });
    void recordTokenLedger(
      userId,
      effectivePlan.enterprise?.organizationId ?? null,
      usedCandidate.slug,
      usedCandidate.modelId,
      tokenUsage,
      reservation?.reserveTokens ?? 0,
    );

    const label = mode === "auto" ? `Auto → ${usedCandidate.displayName}` : usedCandidate.displayName;
    await insertAssistantMessage(conversationId, full, label, {
      thinking,
      citations: searchResults.map((result) => ({ url: result.url, title: result.title })),
      usedThink: think || Boolean(thinking),
      usedSearch: searchActuallyRan,
      usedCanvas: canvas,
    });
    await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
    onEvent({ t: "done" });
  } finally {
    if (reservation) await reconcileQuota(reservation, reconcileTokens);
  }
}
