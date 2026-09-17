import { useSyncExternalStore } from "react";
import type { StreamAcc } from "./raf-batch";
import type { AgentStatus, AssistantStatus, ChatMessage, Citation } from "./types";

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
};

type Draft = LiveSnapshot;

let draft: Draft | null = null;
let snapshot: LiveSnapshot | null = null;
const listeners = new Set<() => void>();

function emit() {
  snapshot = draft
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
      }
    : null;
  listeners.forEach((l) => l());
}

export function startLive(
  chatId: string,
  assistantId: string,
  status: AssistantStatus,
  canvasOn = false,
) {
  draft = {
    chatId,
    assistantId,
    text: "",
    think: "",
    status,
    cites: [],
    agents: [],
    canvasOn,
  };
  emit();
}

/**
 * Marks the in-flight message as canvas-driven once Canvas auto-opens mid-stream (see
 * maybeAutoOpenCanvas in routes/index.tsx) — startLive only knows the toggle state at send time,
 * so without this, a message that earns Canvas later (an html/react/runnable artifact appearing)
 * never gets usedCanvas set, and the chain-of-thought panel's canvas step log never shows for it.
 */
export function markLiveCanvasOn() {
  if (!draft || draft.canvasOn) return;
  draft.canvasOn = true;
  emit();
}

export function applyLive(acc: StreamAcc) {
  if (!draft) return;
  if (acc.text) draft.text += acc.text;
  if (acc.think) draft.think += acc.think;
  if (acc.status) draft.status = acc.status;
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
  emit();
}

export function peekLive() {
  return draft;
}

export function clearLive() {
  draft = null;
  emit();
}

export function isLive() {
  return draft !== null;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot() {
  return snapshot;
}

function getServerSnapshot() {
  return null;
}

export function useLiveStream() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
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
    };
  });
  return hit ? next : messages;
}
