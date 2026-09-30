import { supabaseAdmin } from "../../config/supabase.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { getProviderAdapter } from "../providers/registry.js";
import type { ChatImage, ChatMessage } from "../providers/types.js";
import {
  getModelDisplayName,
  getModelMinTier,
  getModelVisionSupport,
  getWorkingKeyForProvider,
  isFrontierModel,
  listChatCandidates,
  type ChatCandidate,
} from "../providerService.js";
import { rankCandidatesForMessage } from "../modelRouting.js";
import { searchWeb } from "../webSearch.js";
import { recordAdminAuditLog, recordTokenUsage, recordUsageEvent } from "../usageService.js";
import {
  emptyTokenUsage,
  estimateTokenUsageFromText,
  type TokenUsage,
} from "../tokenUsage.js";
import { detectNeedsLiveSearch, shouldProbeForLiveSearch } from "./liveSearchIntent.js";
import { detectImageIntent, findImageCorrection, isShortEnoughForCorrection, type ImageIntent } from "./imageIntent.js";
import { editImage, generateImage } from "../providers/scalemaxImages.js";
import { digitiseDocument, isDigitisable } from "../providers/sarvamDocAI.js";
import { extractOfficeText, isOfficeDocument } from "../providers/officeDocs.js";
import { extractPlainText, isPlainTextDocument } from "../providers/plainTextDocs.js";
import {
  appendExtractedText,
  attachImages,
  modelIdentitySystemMessage,
  trimHistoryToBudget,
  unsupportedAttachmentReason,
  withSystemPreamble,
  withToolPreamble,
} from "./promptContext.js";
import { loadMemoryPrompt } from "../memoryService.js";
import { buildToolset, toolUsePrompt } from "../agent/toolset.js";
import type { FridayTool } from "../agent/tools/types.js";
import { DEEP_RESEARCH_ROUNDS, runToolLoop, supportsTools, type ToolLoopResult } from "../agent/toolLoop.js";
import { DEEP_RESEARCH_PROMPT } from "../agent/toolset.js";
import { streamTeamUp } from "./teamUp.js";
import { detectBuildIntent } from "../projectBuild/intent.js";
import { invalidateMemoized } from "../../utils/ttlMemo.js";
import { streamWithHedging } from "./hedgedStream.js";
import { runBuildAgent } from "../projectBuild/agent.js";
import { alreadyAsked, clarifyRequest, ASK_MARKER } from "../projectBuild/clarify.js";
import type { PermissionMode } from "../projectBuild/approvals.js";
import { PLAN_MARKER, draftPlan, findPendingPlan, isPlanApproval, needsPlan, renderPlan, setPlanStatus } from "../projectBuild/plan.js";
import { clarifyGeneralRequest, mightNeedClarification } from "./clarifyGeneral.js";
import { getProject } from "../projectBuild/sandbox.js";
import { getOwnedConversation, insertAssistantMessage, insertUserMessage } from "./conversations.js";
import { resolveAttachmentDataUrl } from "../attachmentStorage.js";
import type { BuildEffort, BuildPlan, ConversationMode, StreamEvent } from "./types.js";
import { planSatisfiesTier } from "../quota/tierConfig.js";
import { consumeDailyAllowance, entitlementsFor } from "../quota/entitlements.js";
import { recordModelOutcome } from "../status/statusService.js";
import { activeSkillPrompt, getSkill, listSkills, skillMenu, type Skill } from "../skills/skillService.js";
import type { GeneratedFile } from "../documents/documentService.js";
import {
  chargeProgress,
  QUOTA_STOP_MESSAGE,
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
 * Extracts text from every PDF/PNG/JPEG/DOCX/XLSX/plain-text-or-code attachment and returns it
 * combined, or null if nothing extractable was attached or every extraction failed. PDF/image
 * goes through Sarvam's Doc AI digitise pipeline (OCR — verified directly against the real API);
 * DOCX/XLSX are parsed locally (mammoth/exceljs — these are structured XML formats, not scanned
 * documents, and Sarvam's API rejects them outright, confirmed directly: "only JPEG and PNG
 * entries are allowed"); plain text/code (.py, .xml, .csv, .json, .md, etc — see
 * plainTextDocs.ts) is just decoded directly, no parsing needed. Never throws — extraction is a
 * best-effort enhancement layered on top of (not required for) whatever native support the
 * chosen model already has. This is what makes any of these files readable by ANY model, not
 * just ones with native document/vision support, and gives even a non-vision model a way to
 * "read" an image's text.
 */
async function extractDocumentText(attachments: ChatImage[]): Promise<string | null> {
  const officeFiles = attachments.filter((a) => isOfficeDocument(a.mime));
  const digitisableFiles = attachments.filter((a) => isDigitisable(a.mime));
  const plainTextFiles = attachments.filter((a) => isPlainTextDocument(a.mime, a.name));
  if (officeFiles.length === 0 && digitisableFiles.length === 0 && plainTextFiles.length === 0) return null;

  const officeTexts = officeFiles.map((f) => extractOfficeText(f.dataUrl, f.mime));
  const plainTexts = plainTextFiles.map((f) => Promise.resolve(extractPlainText(f.dataUrl, f.mime, f.name)));
  const digitiseTexts = (async () => {
    if (digitisableFiles.length === 0) return [];
    const sarvamKey = await getWorkingKeyForProvider("sarvam").catch(() => null);
    if (!sarvamKey) return digitisableFiles.map(() => Promise.resolve(null));
    return digitisableFiles.map((f, i) => digitiseDocument(sarvamKey, f.dataUrl, f.mime, `attachment-${i + 1}`));
  })();

  const [officeResults, plainTextResults, digitiseResultPromises] = await Promise.all([
    Promise.all(officeTexts),
    Promise.all(plainTexts),
    digitiseTexts,
  ]);
  const digitiseResults = await Promise.all(digitiseResultPromises);
  const allResults = [...officeResults, ...plainTextResults, ...digitiseResults];

  const extracted = allResults
    .map((text, i) => (text ? (allResults.length > 1 ? `[Attachment ${i + 1}]\n${text}` : text) : null))
    .filter((t): t is string => t !== null);
  return extracted.length > 0 ? extracted.join("\n\n") : null;
}

/**
 * Best-effort image generate/edit via ScaleMax — returns the resulting image URL, or null on
 * any failure (no working ScaleMax key, API error, edit requested with no source image) so the
 * caller can fall through to the normal chat path instead of hard-failing the turn.
 */
async function tryGenerateOrEditImage(
  intent: ImageIntent,
  sourceAttachment?: ChatImage,
  correctionSourceUrl?: string | null,
): Promise<string | null> {
  if (!intent) return null;
  try {
    const apiKey = await getWorkingKeyForProvider("scalemax");
    if (intent.kind === "edit") {
      if (sourceAttachment) return await editImage(apiKey, intent.prompt, { dataUrl: sourceAttachment.dataUrl });
      if (correctionSourceUrl) return await editImage(apiKey, intent.prompt, { url: correctionSourceUrl });
      return null;
    }
    return await generateImage(apiKey, intent.prompt);
  } catch (err) {
    console.error("[chat] image generation failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

const CONNECTOR_TOOL_PREFIX = /^(github|gmail|drive|calendar|notion|vercel|railway|supabase|razorpay|mcp)_/;

function adapterHasTools(slug: string): boolean {
  try {
    return typeof getProviderAdapter(slug).chatStreamWithTools === "function";
  } catch {
    return false;
  }
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
 * the real total right before the message that actually spent tokens is recorded. Team Up is
 * metered too: every proposer plus the synthesizer is summed into `reconcileTokens`.
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
  options: { research?: boolean; skillId?: string; effort?: BuildEffort; permissionMode?: PermissionMode } = {},
): Promise<void> {
  // Deep Research always searches; with a tool-capable model it runs a long multi-source tool loop.
  const research = Boolean(options.research) && attachments.length === 0;
  if (research) webSearch = true;
  let reconcileTokens = 0;
  // Stage timings (FRIDAY_CHAT_TIMING=1) — how long each pre-model step takes before the first token.
  const timingStart = Date.now();
  const mark = (label: string) => {
    if (process.env.FRIDAY_CHAT_TIMING) console.log(`[chat timing] +${Date.now() - timingStart}ms ${label}`);
  };
  // What the user's plan / package unlocks (Build Mode, rounds, Deep Research, Team Up size…).
  const entitlementsPromise = entitlementsFor(userId);
  // Skills: the menu the agent can auto-load from, and the one the user explicitly picked (if any).
  const skillsPromise = listSkills(userId).catch(() => [] as Skill[]);
  const activeSkillPromise = options.skillId ? getSkill(userId, options.skillId).catch(() => null) : Promise.resolve(null);
  try {
    const conversation = await getOwnedConversation(userId, conversationId);
    mark("conversation loaded");
    if (research) {
      const allowance = await consumeDailyAllowance(userId, "deep_research", (await entitlementsPromise).deepResearchPerDay);
      if (!allowance.ok) {
        onEvent({
          t: "err",
          c: allowance.limit > 0
            ? `You've used today's ${allowance.limit} Deep Research runs — they reset at midnight UTC. Turn Deep Research off to keep chatting, or upgrade for more.`
            : "Deep Research isn't included in your plan. Turn it off to keep chatting, or upgrade to use it.",
        });
        onEvent({ t: "done" });
        return;
      }
    }
    const mode = conversation.mode as ConversationMode;
    // A session from the Build workspace: every message is for the Build agent (like Claude Code) —
    // no intent probe, no search probe. Team Up / Canvas / Deep Research keep their own flows.
    const buildWorkspace = (conversation as { workspace?: string }).workspace === "build" && mode !== "teamup" && !canvas && !research;

    const userMessageRow = await insertUserMessage(conversationId, content, inputMode, attachments, userId);

    // Intent probes are small model calls (≤2-3s each). They used to run one after the other, on the
    // critical path, before the real reply could start. They depend only on the message text, so kick
    // them off NOW, in parallel with each other and with the history query below, and await them only
    // where the result is needed — the latency hides behind work that had to happen anyway.
    const SHORT_CAPTION_CHARS_EARLY = 20;
    const toolsEnabled = !process.env.FRIDAY_DISABLE_TOOLS;
    // Will this reply run through the agent tool loop? Then the model decides for itself whether to
    // search (web_search is one of its tools), and the pre-flight YES/NO search probe — up to 1.5s
    // on the critical path of every question — is pure added latency before the first token.
    const toolsLikelyPromise: Promise<boolean> =
      !toolsEnabled || webSearch || mode === "teamup"
        ? Promise.resolve(false)
        : mode === "single"
          ? Promise.resolve(Boolean(conversation.providers?.slug) && adapterHasTools(conversation.providers!.slug))
          : listChatCandidates()
              .then((pool) => {
                const first = rankCandidatesForMessage(pool, content)[0];
                return first ? supportsTools(first) : false;
              })
              .catch(() => false);
    const searchIntentPromise: Promise<boolean> =
      !webSearch &&
      !buildWorkspace &&
      (attachments.length === 0 || content.trim().length >= SHORT_CAPTION_CHARS_EARLY) &&
      shouldProbeForLiveSearch(content)
        ? toolsLikelyPromise.then((toolsLikely) => (toolsLikely ? false : detectNeedsLiveSearch(content)))
        : Promise.resolve(false);
    // The toolset (connector + MCP lookups) doesn't depend on anything else — load it alongside.
    const toolsetPromise: Promise<FridayTool[]> | null = toolsEnabled && mode !== "teamup" ? buildToolset(userId) : null;
    toolsetPromise?.catch(() => {});
    mark("user message stored");
    // The plan/tier lookup is a DB round trip that doesn't depend on anything above — start it now.
    const effectivePlanPromise = resolveEffectivePlan(userId);
    // Long-term memory rides along on every turn (all modes); loaded in parallel, never fatal.
    const memoryPromptPromise = loadMemoryPrompt(userId);
    effectivePlanPromise.catch(() => {}); // surfaced where it is awaited; avoids an unhandled rejection on early returns
    // Build Mode runs only in the Build workspace. In normal chat a build-shaped request gets an
    // ordinary answer plus an "Open in Build" offer (suggestBuild) — except in an older chat that
    // already has a project from before the split, which keeps building where it started.
    const chatBuildable = !buildWorkspace && !canvas && !research && mode !== "teamup";
    const chatProjectPromise = chatBuildable ? getProject(conversationId).catch(() => null) : Promise.resolve(null);
    const buildIntentPromise: Promise<boolean> = buildWorkspace
      ? Promise.resolve(true)
      : chatProjectPromise.then((project) => (project ? detectBuildIntent(content, true) : false)).catch(() => false);
    const suggestBuildPromise: Promise<boolean> = chatBuildable
      ? chatProjectPromise.then((project) => (project ? false : detectBuildIntent(content, false))).catch(() => false)
      : Promise.resolve(false);
    void recordUsageEvent(userId, "chat_message", 1, { mode, inputMode });
    if (attachments.length > 0) {
      void recordUsageEvent(userId, "attachment_upload", attachments.length, {
        totalBytes: attachments.reduce((sum, attachment) => sum + (attachment.size ?? 0), 0),
      });
    }

    // Joins message_attachments so an earlier turn's image is still visible to the model on a
    // later turn (e.g. "what's in that image I sent earlier") — previously this only selected
    // role/content, so message_attachments (populated by insertUserMessage below, and already
    // used to redisplay thumbnails in listMessages) was written but never read back into the
    // prompt, meaning an attachment only ever worked on the exact turn it was sent with.
    //
    // Also selects extracted_text (PDF OCR / DOCX/XLSX / plain-text — persisted once at upload
    // time, see the update() right after extractDocumentText() below) so an uploaded document's
    // actual content is recalled on every later turn too, not just images — previously a PDF's
    // text only ever reached the model on the exact turn it was attached; asking about it again
    // one message later got "please upload the original PDF" even though the file was already
    // sitting right there in the conversation.
    const { data: historyRows, error: historyError } = await supabaseAdmin
      .from("messages")
      .select("role, content, extracted_text, message_attachments(mime, data_url, storage_bucket, storage_path)")
      .eq("conversation_id", conversationId)
      .order("created_at");
    if (historyError) throw new HttpError(500, historyError.message);

    const historyWithImages: ChatMessage[] = await Promise.all(
      (historyRows ?? []).map(async (row) => {
        const attachmentRows = (row as { message_attachments?: Array<Record<string, unknown>> | null }).message_attachments;
        const imageRows = (attachmentRows ?? []).filter((a) => String(a.mime ?? "").startsWith("image/"));
        const rowExtractedText = (row as { extracted_text?: string | null }).extracted_text;
        const content = rowExtractedText ? `${row.content}\n\n--- Extracted text from an attached file ---\n${rowExtractedText}` : row.content;
        if (imageRows.length === 0) {
          return { role: row.role, content } as ChatMessage;
        }
        const images: ChatImage[] = await Promise.all(
          imageRows.map(async (a) => ({
            mime: String(a.mime),
            dataUrl: await resolveAttachmentDataUrl({
              data_url: (a.data_url as string | null) ?? null,
              storage_bucket: (a.storage_bucket as string | null) ?? null,
              storage_path: (a.storage_path as string | null) ?? null,
              mime: String(a.mime),
            }),
          })),
        );
        return { role: row.role, content, images: images.filter((img) => img.dataUrl) } as ChatMessage;
      }),
    );

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
    mark("history loaded");
    const autoSearch = await searchIntentPromise;
    mark("search intent resolved");
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
    // Persisted once here so a LATER turn can recall this file's content without the user
    // re-uploading it (see historyWithImages below, which reads this back) — and so Sarvam's
    // paid OCR call never has to re-run for the same file on every subsequent message.
    if (extractedDocText) {
      void supabaseAdmin
        .from("messages")
        .update({ extracted_text: extractedDocText })
        .eq("id", userMessageRow.id)
        .then(({ error }) => {
          if (error) console.error("[chat] failed to persist extracted_text:", error.message);
        });
    }
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

    // Image generation/editing — a separate capability from the text chat models above, routed
    // to ScaleMax's Images API (verified live 2026-09-23; see scalemaxImages.ts). Checked up
    // front, before any mode branching, same as the document gate above: this replaces the whole
    // turn rather than feeding into a chat model. Best-effort — on any failure this falls through
    // to the normal chat path below instead of hard-erroring the turn, so the model can at least
    // respond in text (e.g. explain it couldn't generate the image) rather than the user getting
    // nothing.
    const currentImageAttachment = attachments.find((a) => a.mime.startsWith("image/"));
    let imageIntent = detectImageIntent(content, Boolean(currentImageAttachment));
    let correctionSourceUrl: string | null = null;
    // No explicit generate/edit wording matched — but if the very last reply was itself a real
    // generated image and this message is short (a correction, not a new unrelated request), redo
    // it as an edit of that image using the new wording. See findImageCorrection()'s comment for
    // why this exists and why the length cap keeps it from firing on unrelated follow-ups.
    if (!imageIntent && isShortEnoughForCorrection(content)) {
      const correction = findImageCorrection(historyWithImages);
      if (correction) {
        imageIntent = { kind: "edit", prompt: `${correction.priorPrompt}. Correction: ${content}` };
        correctionSourceUrl = correction.imageUrl;
      }
    }
    if (imageIntent) {
      onEvent({ t: "status", s: "generating_image" });
      const generated = await tryGenerateOrEditImage(imageIntent, currentImageAttachment, correctionSourceUrl);
      if (generated) {
        const caption = imageIntent.kind === "edit" ? "Here's the edited image:" : "Here you go:";
        const markdown = `${caption}\n\n![${content.slice(0, 120)}](${generated})`;
        onEvent({ t: "text", c: markdown });
        void recordUsageEvent(userId, "image_generation", 1, { kind: imageIntent.kind });
        await insertAssistantMessage(conversationId, markdown, "ScaleMax Images", {
          usedCanvas: false,
          usedSearch: false,
          usedThink: false,
        });
        await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
        onEvent({ t: "done" });
        return;
      }
      // Was confidently detected as an image request (explicit generate/edit wording, or a
      // correction right after a real generated image — see imageIntent.ts) — a failure here
      // should say so plainly, not silently fall through and answer the raw text as an ordinary
      // chat prompt (confusing: "create an image of a macbook" makes a nonsensical chat question).
      onEvent({ t: "err", c: "Couldn't create that image right now — the image service may be slow or unavailable. Try again in a moment." });
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

    // Memory + project context are pinned AFTER trimming, so a long chat can never trim them away.
    const memoryPrompt = await memoryPromptPromise;
    const activeSkill = await activeSkillPromise;
    const pinnedContext: ChatMessage[] = [
      ...(memoryPrompt ? [{ role: "system" as const, content: memoryPrompt }] : []),
      ...projectContext,
      ...(activeSkill ? [{ role: "system" as const, content: activeSkillPrompt(activeSkill) }] : []),
    ];
    const history = appendExtractedText(
      attachImages(
        withSystemPreamble(
          [...pinnedContext, ...trimHistoryToBudget(historyWithImages)],
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

    // Meter the real prompt now that it's built: the route's pre-flight reservation only covered the
    // new message, but the model is about to read the whole history. A turn the user can't afford
    // stops here, before any model is paid for.
    const promptTokens = Math.ceil(history.reduce((n, m) => n + m.content.length, 0) / 4) + 800;
    const preflight = await chargeProgress(reservation, promptTokens);
    if (!preflight.ok) {
      const why = QUOTA_STOP_MESSAGE[preflight.reason]!.replace(", so I stopped here.", ".");
      onEvent({ t: "err", c: `${why} This chat's history is larger than what's left — a new chat may still fit, or wait for the reset (Settings → Usage).` });
      onEvent({ t: "done" });
      return;
    }
    const budget = async (spent: number) => {
      const r = await chargeProgress(reservation, spent);
      return r.ok ? null : QUOTA_STOP_MESSAGE[r.reason]!;
    };

    if (mode === "teamup") {
      const hasImageAttachment = attachments.some((a) => a.mime.startsWith("image/"));
      const spent = await streamTeamUp(conversationId, content, history, searchResults, searchActuallyRan, onEvent, signal, {
        think,
        canvas,
        images: attachments,
        requiresVision: hasImageAttachment && !extractedDocText,
        maxModels: (await entitlementsPromise).teamUpModels,
      });
      // Every proposer + the synthesizer counts against the quota (Team Up used to be unmetered).
      if (spent.length > 0) {
        const plan = await effectivePlanPromise.catch(() => null);
        spent.forEach(({ candidate, usage }, i) => {
          reconcileTokens += usage.totalTokens;
          void recordTokenUsage(userId, candidate.slug, candidate.modelId, usage, { conversationId, mode });
          void recordTokenLedger(
            userId,
            plan?.enterprise?.organizationId ?? null,
            candidate.slug,
            candidate.modelId,
            usage,
            i === 0 ? (reservation?.reserveTokens ?? 0) : 0,
          );
        });
      }
      return;
    }

    let candidates: ChatCandidate[];
    let usedVisionFallback = false;
    if (mode === "single") {
      if (!conversation.providers || !conversation.model_id) {
        throw new HttpError(500, "Conversation is missing its provider/model");
      }
      // The vision gate is about actual images needing a multimodal-capable model to see the raw
      // pixels — but Sarvam's OCR extraction gives a non-vision model a way to "read" an image's
      // text too, so this only matters when there's an image AND extraction didn't already cover
      // it (no working Sarvam key, or OCR found nothing — e.g. a low-resolution image with no
      // legible text, confirmed directly against the real API).
      const hasImageAttachment = attachments.some((a) => a.mime.startsWith("image/"));
      const vision = await getModelVisionSupport(conversation.provider_id as string, conversation.model_id);
      // Previously this hard-errored, telling the user to manually switch models. Now it falls
      // back to a vision-capable model for THIS turn only (same ranked pool Auto mode uses,
      // filtered to vision) — the user's picked model stays selected for the conversation, this
      // is just a one-turn substitution so attaching an image never requires a manual model
      // switch. Falls through to the normal single-model path below when the picked model
      // already has vision, or when OCR already covered the image.
      let visionFallback: ChatCandidate | null = null;
      if (hasImageAttachment && !vision && !extractedDocText) {
        const visionPool = rankCandidatesForMessage(await listChatCandidates(), content, true);
        visionFallback = visionPool[0] ?? null;
        if (!visionFallback) {
          onEvent({
            t: "err",
            c: "None of your enabled models can see images — enable a vision-capable model or remove the attachment.",
          });
          onEvent({ t: "done" });
          return;
        }
      }
      // Only a gate now, not the primary path — extractedDocText being non-null means Sarvam
      // already turned the PDF into text that ANY model can read, so a PDF-incapable model is only
      // actually blocked here if that extraction also failed/wasn't available. Skipped entirely
      // when falling back to a different model above (unsupportedAttachmentReason is about the
      // ORIGINALLY selected provider, moot once a different one is about to be used instead).
      const unsupportedReason =
        extractedDocText || visionFallback ? null : unsupportedAttachmentReason(conversation.providers.slug, attachments);
      if (unsupportedReason) {
        onEvent({ t: "err", c: `${conversation.providers.display_name} ${unsupportedReason}` });
        onEvent({ t: "done" });
        return;
      }
      if (visionFallback) {
        candidates = [visionFallback];
        usedVisionFallback = true;
      } else {
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
      }
    } else {
      // Same vision gate single-mode applies, ported to Auto so it can't silently pick a
      // non-vision model that would just ignore the image (see modelRouting.ts).
      const hasImageAttachment = attachments.some((a) => a.mime.startsWith("image/"));
      const requiresVision = hasImageAttachment && !extractedDocText;
      const pool = await listChatCandidates();
      candidates = rankCandidatesForMessage(pool, content, requiresVision);
      if (candidates.length === 0 && requiresVision && pool.length > 0) {
        onEvent({ t: "err", c: "None of your enabled models can see images — enable a vision-capable model or remove the attachment." });
        onEvent({ t: "done" });
        return;
      }
      if (candidates.length === 0) throw new HttpError(503, "No chat models are enabled yet");
    }

    // Plan/tier gate — separate from the token-quota reservation the route middleware already
    // made (that's "can you spend tokens at all"; this is "can you use THIS model"). Resolved
    // once here since it needs the actual candidate(s), which the middleware doesn't have.
    const effectivePlan = await effectivePlanPromise;
    const tierAllows = (c: ChatCandidate) =>
      effectivePlan.enterprise != null || planSatisfiesTier(effectivePlan.plan, c.minTier);
    if (mode === "single") {
      if (!tierAllows(candidates[0]!)) {
        const message = `${candidates[0]!.displayName} needs a higher plan — upgrade to unlock it.`;
        onEvent({ t: "err", c: message });
        onEvent({ t: "done" });
        // Persist so the bubble survives the realtime refetch this same turn's user message
        // triggers (that refetch replaces the local optimistic list with the server's, which
        // otherwise has no assistant row for a turn that never got this far) — see
        // realtime.ts#refetchMessages.
        await insertAssistantMessage(conversationId, "", candidates[0]!.displayName, { error: message });
        return;
      }
    } else {
      candidates = candidates.filter(tierAllows);
      if (candidates.length === 0) {
        const message = "No chat models are available on your current plan yet — upgrade to unlock more.";
        onEvent({ t: "err", c: message });
        onEvent({ t: "done" });
        await insertAssistantMessage(conversationId, "", "Auto", { error: message });
        return;
      }
    }

    // "Which model are you" needs a real, sharable answer (Friday's own label, never the vendor's) —
    // can only be added now that tier filtering/vision fallback has settled on the model actually
    // answering; withSystemPreamble ran too early to know this. See modelIdentitySystemMessage.
    history.push(modelIdentitySystemMessage(candidates[0]!.displayName));

    // Build Mode: a request for a real, runnable project goes to the sandbox agent (write files →
    // install → run → live preview) instead of a plain chat reply. Skipped when the user picked
    // Canvas (single-file preview) — Team Up already returned above.
    mark("candidates + tier resolved");
    if (await buildIntentPromise) {
      const entitlements = await entitlementsPromise;
      if (!entitlements.buildMode) {
        onEvent({ t: "err", c: "Build Mode isn't included in your plan. Upgrade to build and run real projects." });
        onEvent({ t: "done" });
        return;
      }
      onEvent({ t: "status", s: "thinking" });
      // A real build (and the judgment call on whether to ask first) needs a frontier-grade model,
      // not whatever Auto ranked first for a plain chat reply — same bias as Deep Research.
      const buildWorthy = candidates.filter(isFrontierModel);
      if (buildWorthy.length > 0) candidates = buildWorthy;
      const projectFiles = Object.keys((await getProject(conversationId))?.files ?? {});
      const pendingPlan = await findPendingPlan(conversationId);
      let approvedPlan: BuildPlan | undefined;
      if (pendingPlan && isPlanApproval(content)) {
        // The user approved the plan on screen: build exactly that.
        approvedPlan = pendingPlan.plan;
        await setPlanStatus(pendingPlan.messageId, pendingPlan.plan, "approved");
      } else if (pendingPlan || needsPlan(projectFiles.length, content)) {
        // A brand-new project (no files yet, no question round yet) may be missing details that change
        // what gets built — ask first, with a recommended option per question, instead of guessing.
        if (!pendingPlan && !alreadyAsked(history) && projectFiles.length === 0) {
          const questions = await clarifyRequest(history, candidates);
          if (questions.length > 0 && !signal?.aborted) {
            onEvent({ t: "ask", questions });
            await insertAssistantMessage(conversationId, ASK_MARKER, "Build", { usedCanvas: false, usedSearch: false, usedThink: false, build: { steps: [], ask: questions } });
            await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
            onEvent({ t: "done" });
            return;
          }
        }
        // Plan round: draft (or, when a plan is waiting, revise it with this message as the feedback)
        // and stop. Nothing is built — no sandbox, no cost — until the user approves.
        const stateNote = projectFiles.length
          ? `EXISTING PROJECT (${projectFiles.length} files): ${projectFiles.slice(0, 60).join(", ")}${projectFiles.length > 60 ? ", …" : ""}.`
          : "This is a new, empty project.";
        const drafted = await draftPlan({
          history,
          candidates,
          stateNote,
          ...(pendingPlan ? { revise: { plan: pendingPlan.plan, feedback: content } } : {}),
        });
        if (drafted && !signal?.aborted) {
          if (pendingPlan) await setPlanStatus(pendingPlan.messageId, pendingPlan.plan, "revised");
          const { plan } = drafted;
          onEvent({ t: "plan", architecture: plan.architecture, summary: plan.summary, status: plan.status, items: plan.items });
          await insertAssistantMessage(conversationId, `${PLAN_MARKER}\n\n${renderPlan(plan)}`, "Build", {
            usedCanvas: false,
            usedSearch: false,
            usedThink: false,
            build: { steps: [], plan },
          });
          await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
          const planner = candidates[0];
          if (planner) {
            reconcileTokens = drafted.usage.totalTokens;
            void recordTokenUsage(userId, planner.slug, planner.modelId, drafted.usage, { conversationId, mode });
            void recordTokenLedger(userId, effectivePlan.enterprise?.organizationId ?? null, planner.slug, planner.modelId, drafted.usage, reservation?.reserveTokens ?? 0);
          }
          onEvent({ t: "done" });
          return;
        }
        if (pendingPlan) {
          // Couldn't revise it — keep the current plan on screen rather than building something unapproved.
          onEvent({ t: "err", c: "Couldn't update the plan just now. Try again, or approve the current plan to start." });
          onEvent({ t: "done" });
          return;
        }
        // No usable plan from the model: build anyway rather than leave the user stuck.
      }
      // Tell the client right away (sandbox startup takes a few seconds) so it can show Build Mode —
      // only now, not during a question/plan round, which never touches the sandbox.
      onEvent({ t: "status", s: "building" });
      const built = await runBuildAgent({ userId, conversationId, history, candidates, onEvent, signal, budget, maxRounds: entitlements.buildMaxRounds, approvedPlan, effort: options.effort, permissionMode: options.permissionMode });
      if (built.error && !built.text && built.build.steps.length === 0) {
        onEvent({ t: "err", c: built.error });
        onEvent({ t: "done" });
        return;
      }
      if (built.candidate) {
        reconcileTokens = built.usage.totalTokens;
        void recordTokenUsage(userId, built.candidate.slug, built.candidate.modelId, built.usage, { conversationId, mode });
        void recordTokenLedger(
          userId,
          effectivePlan.enterprise?.organizationId ?? null,
          built.candidate.slug,
          built.candidate.modelId,
          built.usage,
          reservation?.reserveTokens ?? 0,
        );
      }
      onEvent({ t: "build", elapsedMs: built.build.elapsedMs, zipBytes: built.build.zipBytes, zipName: built.build.zipName, prUrl: built.build.prUrl });
      const buildLabel = mode === "auto" ? `Auto → ${built.candidate?.displayName ?? "Build"}` : (built.candidate?.displayName ?? "Build");
      await insertAssistantMessage(conversationId, built.text || "Done.", buildLabel, {
        usedCanvas: false,
        usedSearch: false,
        usedThink: false,
        build: built.build,
        error: built.error,
      });
      await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
      if (built.error) onEvent({ t: "err", c: built.error });
      onEvent({ t: "done" });
      return;
    }

    // A build-shaped request in normal chat: Build Mode lives in the Build workspace now, so answer
    // it here as a normal reply and offer to take it there (the client renders "Open in Build").
    const suggestBuild = await suggestBuildPromise;
    if (suggestBuild) {
      onEvent({ t: "suggest_build", prompt: content });
      history.push({
        role: "system",
        volatile: true,
        content:
          "This message asks for a real project to be built. Friday's Build workspace (the Build tab in the sidebar) is where that happens: it plans the project, the user approves the plan, then it writes the code, runs it in a sandbox and shows a live preview. " +
          "In this chat, help directly — outline the approach, or give the code if it's small — and keep it reasonably short. The app shows an \"Open in Build\" button under your reply, so you don't need to explain how to get there beyond one short line.",
      });
    }

    // Non-build tasks can hide missing specifics too — who to send/message, a real date or name,
    // specific content a wrong guess would waste — same "ask once, recommended default first"
    // pattern as Build Mode's clarify round above, gated behind mightNeedClarification's cheap
    // heuristic so ordinary chat (questions, conversation, search-style asks) never pays for a
    // probe it doesn't need. Deep Research and Canvas skip this — they have their own flows.
    if (!canvas && !research && !alreadyAsked(history) && mightNeedClarification(content)) {
      const questions = await clarifyGeneralRequest(history, candidates);
      if (questions.length > 0 && !signal?.aborted) {
        onEvent({ t: "ask", questions });
        await insertAssistantMessage(conversationId, ASK_MARKER, "Friday", { usedCanvas: false, usedSearch: false, usedThink: false, build: { steps: [], ask: questions } });
        await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
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

    // Agent path: when the chosen model supports native tool calling, it gets real tools (web search,
    // page reading, memory, and the user's connected GitHub/Gmail/Drive/Calendar) and runs a bounded
    // tool loop. If that path can't start at all (e.g. a model that rejects tools), fall back to the
    // plain streaming path below, so tools can only ever add capability, never break chat.
    const extraCitations: { url: string; title?: string }[] = [];
    const createdFiles: GeneratedFile[] = [];
    let toolRun: ToolLoopResult | null = null;
    const toolStarted = Date.now();
    // Deep Research in Auto/Team-Up prefers a tool-capable, frontier-grade model — the same
    // denylist Build Mode uses to avoid the cheapest chat-tier model doing the actual research —
    // even if routing ranked something lighter first. An explicit single-model pick is respected.
    if (research && mode !== "single") {
      const toolCapable = candidates.filter(supportsTools);
      const frontier = toolCapable.filter(isFrontierModel);
      candidates = [...(frontier.length ? frontier : toolCapable), ...candidates.filter((c) => !supportsTools(c))];
    }
    if (!process.env.FRIDAY_DISABLE_TOOLS && supportsTools(candidates[0]!)) {
      if (research) onEvent({ t: "status", s: "searching" });
      const tools = await (toolsetPromise ?? buildToolset(userId));
      const citedUrls = new Set(searchResults.map((r) => r.url));
      // An explicitly chosen skill is already pinned — don't also offer the menu (it would compete).
      const menu = activeSkill ? "" : skillMenu(await skillsPromise);
      const guidance = toolUsePrompt(tools, menu) + (research ? `\n\n${DEEP_RESEARCH_PROMPT}` : "");
      toolRun = await runToolLoop({
        candidates: candidates.filter(supportsTools),
        history: withToolPreamble(history, guidance),
        tools,
        maxRounds: research ? DEEP_RESEARCH_ROUNDS : undefined,
        budget,
        ctx: {
          userId,
          conversationId,
          signal,
          onFile: (file) => {
            createdFiles.push(file);
            onEvent({ t: "file", file });
          },
          onCite: (url, title) => {
            if (citedUrls.has(url)) return;
            citedUrls.add(url);
            extraCitations.push({ url, title });
            onEvent({ t: "cite", u: url, title });
          },
        },
        onText: (delta) => {
          if (!full) mark("first token");
          full += delta;
          onEvent({ t: "text", c: delta });
        },
        onStep: (step) => onEvent({ t: "step", ...step }),
      });
      if (!toolRun.candidate) {
        if (toolRun.error) console.warn(`[chat] tool path unavailable, falling back: ${toolRun.error}`);
        toolRun = null;
        full = "";
      } else {
        usedCandidate = toolRun.candidate;
        full = toolRun.text;
        tokenUsage = toolRun.usage;
        sawProviderUsage = true;
        lastError = toolRun.error;
        const webCalls = toolRun.toolNames.filter((name) => name === "web_search" || name === "fetch_url").length;
        if (webCalls > 0) void recordUsageEvent(userId, "web_search", webCalls, { viaTools: true });
        // Audit trail for anything that touched the user's connected accounts (compliance / "what did Friday read?").
        const connectorCalls = toolRun.toolNames.filter((name) => CONNECTOR_TOOL_PREFIX.test(name));
        if (connectorCalls.length > 0) {
          void recordAdminAuditLog(userId, "agent.connector_tools", "conversation", conversationId, { tools: connectorCalls }).catch(() => {});
        }
      }
    }

    // Failover + hedging (see hedgedStream.ts): a slow first candidate is raced against the next one.
    const HEDGE_MS = Number(process.env.FRIDAY_HEDGE_MS ?? 2200);
    const streamed = toolRun ? null : await streamWithHedging({
      candidates,
      history,
      signal,
      hedgeAfterMs: mode === "single" ? 0 : HEDGE_MS,
      onText: (delta) => {
        if (!full) mark("first token");
        full += delta;
        onEvent({ t: "text", c: delta });
      },
      onThink: (delta) => {
        thinking += delta;
        onEvent({ t: "think", c: delta });
      },
    });
    if (streamed?.candidate) {
      usedCandidate = streamed.candidate;
      full = streamed.text || full;
      thinking = streamed.thinking || thinking;
      if (streamed.usage) {
        tokenUsage = streamed.usage;
        sawProviderUsage = true;
      }
      if (streamed.hedged) console.log(`[chat] hedged: ${streamed.candidate.slug}/${streamed.candidate.modelId} answered first`);
    }
    if (streamed) lastError = streamed.lastError;

    // Real-traffic model uptime for /status: did the model that handled this turn actually answer?
    const outcomeModel = usedCandidate ?? candidates[0];
    if (outcomeModel) void recordModelOutcome(outcomeModel.slug, outcomeModel.modelId, Boolean(usedCandidate) && (full.trim().length > 0 || !lastError));

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

    const label =
      mode === "auto"
        ? `Auto → ${usedCandidate.displayName}`
        : usedVisionFallback
          ? `${usedCandidate.displayName} (switched to see your image)`
          : usedCandidate.displayName;
    const toolSteps = toolRun?.steps ?? [];
    if (toolRun?.error) onEvent({ t: "err", c: "The reply was cut short — the model stopped responding. Send another message to continue." });
    await insertAssistantMessage(conversationId, full, label, {
      thinking,
      citations: [...searchResults.map((result) => ({ url: result.url, title: result.title })), ...extraCitations],
      usedThink: think || Boolean(thinking),
      usedSearch: searchActuallyRan || extraCitations.length > 0,
      usedCanvas: canvas,
      ...(toolSteps.length || suggestBuild
        ? {
            build: {
              steps: toolSteps,
              ...(toolSteps.length ? { elapsedMs: Date.now() - toolStarted } : {}),
              ...(suggestBuild ? { suggestBuild: { prompt: content.slice(0, 4000) } } : {}),
            },
          }
        : {}),
      ...(toolRun?.error ? { error: toolRun.error } : {}),
      ...(createdFiles.length ? { files: createdFiles } : {}),
    });
    await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
    onEvent({ t: "done" });
  } finally {
    if (reservation) await reconcileQuota(reservation, reconcileTokens);
  }
}
