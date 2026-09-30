import { useEffect } from "react";
import { api } from "@/lib/api";
import {
  applyLive,
  applyLiveStep,
  clearLive,
  isLive,
  setLiveBuildMeta,
  setLivePlan,
  setLivePreview,
  startLive,
  upsertLiveApproval,
} from "@/lib/chat/live-stream";
import { isStreamActive } from "@/lib/chat/active-streams";
import { useChat, type ServerMessage } from "@/lib/chat/store";
import type { StreamEvent } from "@/lib/chat/types";
import { useBuildSessions } from "@/lib/build-mode/sessions";

const EMPTY = { text: "", think: "", cites: [], agents: [] };

/** Applies one logged Build event to the live view — the same effect the SSE handler has in send(). */
function applyEvent(chatId: string, ev: StreamEvent) {
  if (ev.t === "status") applyLive(chatId, { ...EMPTY, status: ev.s });
  else if (ev.t === "text") applyLive(chatId, { ...EMPTY, text: ev.c });
  else if (ev.t === "think") applyLive(chatId, { ...EMPTY, think: ev.c });
  else if (ev.t === "step") {
    const { t: _t, ...step } = ev;
    applyLiveStep(chatId, step);
  } else if (ev.t === "plan") setLivePlan(chatId, { architecture: ev.architecture, items: ev.items, summary: ev.summary, status: ev.status });
  else if (ev.t === "preview") setLivePreview(chatId, ev.url, ev.port);
  else if (ev.t === "build") setLiveBuildMeta(chatId, { elapsedMs: ev.elapsedMs, zipBytes: ev.zipBytes, zipName: ev.zipName, prUrl: ev.prUrl });
  else if (ev.t === "approval") {
    const { t: _t, ...approval } = ev;
    upsertLiveApproval(chatId, approval);
  } else if (ev.t === "err") applyLive(chatId, { ...EMPTY, error: ev.c });
}

/**
 * Live resume: opening a Build session that's running with no stream in this tab (started on another
 * device, or before a reload) replays the turn from the event log and keeps following it until it
 * ends, then loads the saved result. Only starts once the server confirms the build is running.
 */
export function useBuildLiveResume(opts: { enabled: boolean; chatId: string | null; conversationId: string | undefined; status: string | undefined }) {
  const { enabled, chatId, conversationId, status } = opts;
  useEffect(() => {
    if (!enabled || !chatId || !conversationId || (status !== "running" && status !== "needs_input")) return;
    if (isStreamActive(chatId) || isLive(chatId)) return;
    let cancelled = false;
    let timer: number | undefined;
    let after = 0;
    let started = false;
    const assistantId = `resume-${Date.now()}`;

    const finish = async () => {
      try {
        const res = await api.get<{ messages: ServerMessage[] }>(`/chat/conversations/${conversationId}/messages`);
        if (!cancelled) useChat.getState().loadMessagesInto(chatId, res.messages);
      } catch {
        /* the next open / focus refetches */
      }
      clearLive(chatId);
      void useBuildSessions.getState().load();
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await api.get<{ events: { id: number; event: StreamEvent }[]; running: boolean }>(`/build/${conversationId}/events?after=${after}`);
        if (cancelled) return;
        if (!started) {
          if (!res.running) return; // finished in the meantime — the saved messages are already current
          started = true;
          useChat.setState((st) => ({
            chats: st.chats.map((c) =>
              c.id !== chatId
                ? c
                : { ...c, messages: [...c.messages, { id: assistantId, role: "assistant" as const, content: "", createdAt: Date.now(), streaming: true, status: "building" as const }] },
            ),
          }));
          startLive(chatId, assistantId, "building");
        }
        for (const { id, event } of res.events) {
          after = id;
          applyEvent(chatId, event);
        }
        if (!res.running && res.events.length === 0) {
          await finish();
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      timer = window.setTimeout(() => void tick(), 1200);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      if (started) clearLive(chatId);
    };
  }, [enabled, chatId, conversationId, status]);
}
