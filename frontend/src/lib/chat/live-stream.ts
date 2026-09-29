import { useSyncExternalStore } from "react";
import type { StreamAcc } from "./raf-batch";
import type { AgentStatus, AssistantStatus, BuildPlan, BuildStep, ChatMessage, Citation, GeneratedFile } from "./types";

export type LiveSnapshot = {
  chatId: string;
  assistantId: string;
  text: string;
  think: string;
  status: AssistantStatus;
  cites: Citation[];
  agents: AgentStatus[];
  error?: string;
  canvasOn: boolean;
  steps: BuildStep[];
  preview?: { url: string; port: number };
  meta?: { elapsedMs?: number; zipBytes?: number; zipName?: string; prUrl?: string };
  /** True once the server announced Build Mode (status "building") — keeps the start-up banner up
   *  until the first step exists, even though narration text flips status to "writing" meanwhile. */
  buildStarted?: boolean;
  plan?: BuildPlan;
  files?: GeneratedFile[];
};

type Draft = LiveSnapshot;

// Keyed by chatId instead of a single global slot — a single `draft`/`snapshot` pair meant only
// ONE chat could ever be "live" at a time: starting a turn in a second chat silently clobbered
// whichever chat was already streaming, orphaning its live updates (the underlying request kept
// running server-side, but nothing showed it — and see active-streams.ts for the matching abort
// bug this was paired with). Every chat now gets its own slot, so switching chats or opening a
// new one mid-reply no longer disturbs whatever else is in flight.
const drafts = new Map<string, Draft>();
const snapshots = new Map<string, LiveSnapshot | null>();
const listeners = new Set<() => void>();

function emit(chatId: string) {
  const draft = drafts.get(chatId);
  snapshots.set(
    chatId,
    draft
      ? {
          chatId: draft.chatId,
          assistantId: draft.assistantId,
          text: draft.text,
          think: draft.think,
          status: draft.status,
          cites: draft.cites.slice(),
          agents: draft.agents.slice(),
          error: draft.error,
          canvasOn: draft.canvasOn,
          steps: draft.steps.slice(),
          preview: draft.preview,
          meta: draft.meta,
          buildStarted: draft.buildStarted,
          plan: draft.plan,
          files: draft.files?.slice(),
        }
      : null,
  );
  listeners.forEach((l) => l());
}

export function startLive(
  chatId: string,
  assistantId: string,
  status: AssistantStatus,
  canvasOn = false,
) {
  drafts.set(chatId, {
    chatId,
    assistantId,
    text: "",
    think: "",
    status,
    cites: [],
    agents: [],
    canvasOn,
    steps: [],
  });
  emit(chatId);
}

/**
 * Marks the in-flight message as canvas-driven once Canvas auto-opens mid-stream (see
 * maybeAutoOpenCanvas in routes/index.tsx) — startLive only knows the toggle state at send time,
 * so without this, a message that earns Canvas later (an html/react/runnable artifact appearing)
 * never gets usedCanvas set, and the chain-of-thought panel's canvas step log never shows for it.
 */
export function markLiveCanvasOn(chatId: string) {
  const draft = drafts.get(chatId);
  if (!draft || draft.canvasOn) return;
  draft.canvasOn = true;
  emit(chatId);
}

export function applyLive(chatId: string, acc: StreamAcc) {
  const draft = drafts.get(chatId);
  if (!draft) return;
  if (acc.text) draft.text += acc.text;
  if (acc.think) draft.think += acc.think;
  if (acc.status) draft.status = acc.status;
  if (acc.status === "building") draft.buildStarted = true;
  if (acc.cites.length) {
    for (const c of acc.cites) {
      if (!draft.cites.some((x) => x.url === c.url)) draft.cites.push(c);
    }
  }
  if (acc.agents.length) {
    for (const a of acc.agents) {
      const i = draft.agents.findIndex((x) => x.slug === a.slug && x.model === a.model);
      if (i === -1) draft.agents.push(a);
      else draft.agents[i] = a;
    }
  }
  if (acc.error) draft.error = acc.error;
  emit(chatId);
}

/** Build Mode: upserts a step (matched by id — the server re-sends it as it goes running → ok/error). */
export function applyLiveStep(chatId: string, step: BuildStep) {
  const draft = drafts.get(chatId);
  if (!draft) return;
  const i = draft.steps.findIndex((s) => s.id === step.id);
  if (i === -1) draft.steps.push(step);
  else draft.steps[i] = step;
  emit(chatId);
}

export function setLivePlan(chatId: string, plan: BuildPlan) {
  const draft = drafts.get(chatId);
  if (!draft) return;
  draft.plan = plan;
  emit(chatId);
}

export function setLiveBuildMeta(chatId: string, meta: { elapsedMs?: number; zipBytes?: number; zipName?: string; prUrl?: string }) {
  const draft = drafts.get(chatId);
  if (!draft) return;
  draft.meta = meta;
  emit(chatId);
}

export function addLiveFile(chatId: string, file: GeneratedFile) {
  const draft = drafts.get(chatId);
  if (!draft) return;
  draft.files = [...(draft.files ?? []).filter((f) => f.id !== file.id), file];
  emit(chatId);
}

export function setLivePreview(chatId: string, url: string, port: number) {
  const draft = drafts.get(chatId);
  if (!draft) return;
  draft.preview = { url, port };
  emit(chatId);
}

export function peekLive(chatId: string) {
  return drafts.get(chatId) ?? null;
}

export function clearLive(chatId: string) {
  drafts.delete(chatId);
  emit(chatId);
}

export function isLive(chatId: string) {
  return drafts.has(chatId);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getServerSnapshot() {
  return null;
}

/** Live snapshot for one specific chat — pass the chat actually being viewed/acted on (usually
 *  the active chat), not a global "whatever's live" value, now that several can be live at once. */
export function useLiveStream(chatId: string | null | undefined) {
  return useSyncExternalStore(
    subscribe,
    () => (chatId ? snapshots.get(chatId) ?? null : null),
    getServerSnapshot,
  );
}

export function overlayLive(
  messages: ChatMessage[],
  live: LiveSnapshot | null,
): ChatMessage[] {
  if (!live) return messages;
  let hit = false;
  const next = messages.map((m) => {
    if (m.id !== live.assistantId) return m;
    hit = true;
    return {
      ...m,
      content: live.text,
      thinking: live.think || m.thinking,
      citations: live.cites.length ? live.cites : m.citations,
      agents: live.agents.length ? live.agents : m.agents,
      status: live.status,
      error: live.error ?? m.error,
      streaming: true,
      // Search can now auto-trigger server-side even when the Search toggle was off (see
      // backend's liveSearchIntent.ts) — a live "searching" status or arriving citations is
      // authoritative that search happened for this message, regardless of the toggle state at
      // send time, so the chain-of-thought panel/sources still render for it.
      usedSearch: m.usedSearch || live.status === "searching" || live.cites.length > 0,
      usedCanvas: m.usedCanvas || live.canvasOn,
      files: live.files?.length ? live.files : m.files,
      build: live.steps.length || live.preview || live.buildStarted || live.plan
        ? { plan: live.plan, steps: live.steps, previewUrl: live.preview?.url, port: live.preview?.port, ...live.meta }
        : m.build,
    };
  });
  return hit ? next : messages;
}
