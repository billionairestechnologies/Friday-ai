import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { getProviderAdapter } from "../providers/registry.js";
import type { ChatImage, ChatMessage } from "../providers/types.js";
import {
  getModelDisplayName,
  getModelVisionSupport,
  getWorkingKeyForProvider,
  listChatCandidates,
  type ChatCandidate,
} from "../providerService.js";
import { rankCandidatesForMessage } from "../modelRouting.js";
import { searchWeb } from "../webSearch.js";
import { digitisePdf } from "../providers/sarvamDocAI.js";
import {
  appendExtractedText,
  attachImages,
  trimHistoryToBudget,
  unsupportedAttachmentReason,
  withSystemPreamble,
} from "./promptContext.js";
import { streamTeamUp } from "./teamUp.js";
import { getOwnedConversation, insertAssistantMessage } from "./conversations.js";
import type { ConversationMode, StreamEvent } from "./types.js";

export type { StreamEvent, ConversationMode } from "./types.js";
export {
  createConversation,
  updateConversationModel,
  listConversations,
  deleteConversation,
  listMessages,
} from "./conversations.js";

/**
 * Runs every attached PDF through Sarvam's Doc AI digitise pipeline and returns the combined
 * extracted text, or null if there's no PDF, no working Sarvam key, or extraction failed — never
 * throws, since this is a best-effort enhancement layered on top of (not required for) whatever
 * native PDF support the chosen model already has. This is what makes a PDF readable by ANY
 * model, not just Anthropic/Gemini — see appendExtractedText() in promptContext.ts.
 */
async function extractPdfText(attachments: ChatImage[]): Promise<string | null> {
  const pdfs = attachments.filter((a) => a.mime === "application/pdf");
  if (pdfs.length === 0) return null;

  const sarvamKey = await getWorkingKeyForProvider("sarvam").catch(() => null);
  if (!sarvamKey) return null;

  const texts = await Promise.all(pdfs.map((pdf, i) => digitisePdf(sarvamKey, pdf.dataUrl, `document-${i + 1}.pdf`)));
  const extracted = texts
    .map((text, i) => (text ? (pdfs.length > 1 ? `[PDF ${i + 1}]\n${text}` : text) : null))
    .filter((t): t is string => t !== null);
  return extracted.length > 0 ? extracted.join("\n\n") : null;
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
  canvas = false,
  attachments: ChatImage[] = [],
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
  const extractedPdfText = await extractPdfText(attachments);
  const history = appendExtractedText(
    attachImages(
      withSystemPreamble(trimHistoryToBudget(historyRows as ChatMessage[]), think, behavior, webSearch, searchResults, canvas),
      attachments,
    ),
    extractedPdfText,
  );

  if (mode === "teamup") {
    await streamTeamUp(conversationId, content, history, searchResults, webSearch, onEvent, signal);
    return;
  }

  let candidates: ChatCandidate[];
  if (mode === "single") {
    if (!conversation.providers || !conversation.model_id) {
      throw new HttpError(500, "Conversation is missing its provider/model");
    }
    // The vision gate is about actual images needing a multimodal-capable model — a PDF isn't an
    // image, and once extractedPdfText exists it's just plain text any model can read, so a PDF
    // must never trip this even on a non-vision model like Sarvam's plain chat model.
    const hasImageAttachment = attachments.some((a) => a.mime.startsWith("image/"));
    const vision = await getModelVisionSupport(conversation.provider_id as string, conversation.model_id);
    if (hasImageAttachment && !vision) {
      onEvent({
        t: "err",
        c: `${conversation.providers.display_name} can't see images — pick a vision-capable model or remove the attachment.`,
      });
      onEvent({ t: "done" });
      return;
    }
    // Only a gate now, not the primary path — extractedPdfText being non-null means Sarvam
    // already turned the PDF into text that ANY model can read, so a PDF-incapable model is only
    // actually blocked here if that extraction also failed/wasn't available.
    const unsupportedReason = extractedPdfText ? null : unsupportedAttachmentReason(conversation.providers.slug, attachments);
    if (unsupportedReason) {
      onEvent({ t: "err", c: `${conversation.providers.display_name} ${unsupportedReason}` });
      onEvent({ t: "done" });
      return;
    }
    candidates = [
      {
        slug: conversation.providers.slug,
        providerDisplayName: conversation.providers.display_name,
        modelId: conversation.model_id,
        displayName: await getModelDisplayName(conversation.provider_id as string, conversation.model_id),
        vision,
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
